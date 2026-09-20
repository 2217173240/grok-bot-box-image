// 快照剥离。这是整个服务里最不能出错的一块。
//
// 为什么必须自己剥：input[type=password] 在 ARIA 里没有独立 role，就是普通 textbox，
// 而 ariaSnapshot 会把 value 一并吐出来 —— 实测输出过 `- textbox "密码" [ref=f2e7]: hunter2`。
// 照原样透传 = 把用户密码递给调用方的模型（《可行性实测》§2.1，规格 §7.1）。
//
// 为什么只解析 textbox 类角色而不是全量 ref：实测 10 个 ref 要 53ms，
// 真实页面几百个 ref 会到秒级。密码/OTP/卡号只可能落在输入类角色上。

import { snapshotEmpty, actionBlocked } from './errors.mjs';

// 会承载用户输入的角色。checkbox/radio 之类不带自由文本，不解析。
const INPUT_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
]);

// autocomplete 命中这些即视为敏感（规格 §7.1）
const SENSITIVE_AC = new Map([
  ['one-time-code', 'otp'],
  ['cc-number', 'payment'],
  ['cc-csc', 'payment'],
  ['cc-exp', 'payment'],
]);

// 规格 §6.2 的原话是「**角色**像验证码 / 支付」。曾经的实现是把整份快照小写化后做
// 全文子串匹配，比规格宽得多：任何页面只要正文里出现「验证码」三个字 —— 一篇讲验证码的
// 博客就够 —— 就会翻进 awaiting_human、在用户 Mac 上弹浏览器、并拒绝一切后续操作，
// 直到人来 release 或 15 分钟超时。而真的 reCAPTCHA 在 iframe 里、正文不含这些字时反而
// 不触发。**同时误触发和漏触发**（2026-08-14 code review 查出）。
//
// 现在按角色收窄：只看验证码控件真正会呈现成的那几种角色，且只匹配节点的**可访问名**
// （splitLine 的 head，不含正文），不看正文。
const CAPTCHA_ROLES = new Set([
  'iframe',    // reCAPTCHA / hCaptcha / Turnstile 都是 iframe，title 一般就叫 reCAPTCHA
  'button',
  'checkbox',  // reCAPTCHA v2 的「我不是机器人」
  'img',       // 图形验证码
  'textbox',   // 「请输入验证码」输入框
]);

const CAPTCHA_HINTS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  'turnstile',
  '验证码',
  '人机验证',
  '我不是机器人',
];

/**
 * 支付字段的可访问名启发式。**和上面 captcha 那套同源，也同样收窄**：
 * 只看节点的可访问名（splitLine 的 head，不含正文），且只在输入类角色上判。
 *
 * 为什么要有它：规格 §6.2 说的是「角色像**验证码 / 支付**」，而实现里 payment 此前
 * 只有 SENSITIVE_AC 那一条来源 —— 一个不写 `autocomplete` 的收银台（相当常见），
 * 卡号框既不翻 awaiting_human、`fill` 也不会被拒，agent 能直接把卡号敲进去。
 * captcha 有整套角色启发式，payment 一条没有，两边不对等。
 *
 * 宁可多挡：误判的代价是「人来接管一次」（本来就是设计好的路径），漏判的代价是
 * 「模型往真实收银台里填卡号」。这和本文件开头「判不了类型就当敏感处理」是同一条取舍。
 */
const PAYMENT_HINTS = [
  '卡号',
  '信用卡',
  '银行卡',
  '安全码',
  'card number',
  'cardnumber',
  'credit card',
  'cvv',
  'cvc',
];
const looksLikePaymentName = (s) => {
  const n = String(s ?? '').toLowerCase();
  return PAYMENT_HINTS.some((h) => n.includes(h));
};

// reason 的优先级：谁在场就报谁，密码最要紧
const REASON_RANK = { password: 0, otp: 1, payment: 2, captcha: 3, other: 4 };

// 拆一行：前半段（含 ref 与其后的属性）、ref、值。
// 值的形态是 `... [ref=f2e7]: hunter2`，也可能是 `: |` 起头的多行块。
//
// 关键：无障碍名里含冒号、控制字符等需要 YAML 转义的内容时，Playwright 会把
// 整个键用引号包起来 —— `- 'textbox "密码" [ref=e7]': "hunter2"`。
// 早先这里的 role 正则是 `^\s*-\s*([a-zA-Z]+)`，撞上开头那个引号就匹配不到，
// 该节点被整个跳过：不检出、不剥离，密码明文原样返回给调用方。
// 所以开闭引号都必须显式处理，不能假设键是裸的。
function splitLine(line) {
  const at = line.indexOf('[ref=');
  if (at < 0) return null;
  const close = line.indexOf(']', at);
  if (close < 0) return null;
  const ref = line.slice(at + 5, close);

  // ref 之后可能还有 [disabled] 之类属性，一并算进 head
  let i = close + 1;
  const attrs = line.slice(i).match(/^(\s*\[[^\]]*\])*/)?.[0] ?? '';
  i += attrs.length;

  // 键被引号包起来时，闭合引号也算 head 的一部分，否则补 [password] 会得到不配对的引号
  const quote = line.slice(i).match(/^['"]/)?.[0];
  if (quote) i += 1;

  const tail = line.slice(i);
  const hasValue = tail.startsWith(':');
  return {
    ref,
    head: line.slice(0, i),
    value: hasValue ? tail.slice(1).trim() : null,
    // 允许角色名前有一个开引号
    role: line.match(/^\s*-\s*['"]?([a-zA-Z]+)/)?.[1] ?? '',
  };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * 取快照并剥离敏感值。
 * @returns {{snapshot: string, needsHuman: boolean, reason: string|null, sensitiveRefs: Set<string>}}
 */
export async function takeStrippedSnapshot(page) {
  // 注意：方法是 ariaSnapshot({mode:"ai"})，不是 _snapshotForAI —— 后者在 playwright-core 上不存在。
  let raw;
  try {
    raw = await page.ariaSnapshot({ mode: 'ai' });
  } catch (e) {
    throw snapshotEmpty(`ariaSnapshot 失败：${e.message}`);
  }
  if (!raw || !raw.trim()) throw snapshotEmpty('页面没有可用的无障碍结构');

  const lines = raw.split('\n');
  const parsed = lines.map(splitLine);

  // 只对输入类角色解析 DOM
  const candidates = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p && INPUT_ROLES.has(p.role)) candidates.push({ index: i, ...p });
  }

  const infos = await Promise.all(
    candidates.map(async (c) => {
      try {
        const info = await page
          .locator('aria-ref=' + c.ref)
          .evaluate((el) => ({ type: el.type, ac: el.autocomplete }));
        return { ...c, ...info };
      } catch {
        // ref 失效（页面变了）。判不了类型就当敏感处理，宁可抹掉也不放明文出去。
        return { ...c, type: 'password', ac: '', unresolved: true };
      }
    })
  );

  const sensitiveRefs = new Set();
  const secrets = [];
  let reason = null;
  const noteReason = (r) => {
    if (reason === null || REASON_RANK[r] < REASON_RANK[reason]) reason = r;
  };

  const out = [...lines];
  const dropped = new Set(); // 多行值块里被抹掉的行

  for (const info of infos) {
    const ac = String(info.ac ?? '').toLowerCase();
    let hit = null;
    if (String(info.type ?? '').toLowerCase() === 'password') hit = 'password';
    else {
      for (const [needle, r] of SENSITIVE_AC) {
        if (ac.includes(needle)) { hit = r; break; }
      }
    }
    // autocomplete 没标就看可访问名（candidates 已经只剩输入类角色了）。
    // 不写 autocomplete 的收银台很常见，那时这是唯一能认出卡号框的东西。
    if (!hit && looksLikePaymentName(info.head)) hit = 'payment';
    if (!hit) continue;

    sensitiveRefs.add(info.ref);
    noteReason(hit);

    const line = lines[info.index];
    if (info.value !== null) {
      if (info.value === '|' || info.value === '|-') {
        // 多行值块：把后续缩进更深的行整块丢掉
        const base = indentOf(line);
        for (let j = info.index + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') { dropped.add(j); continue; }
          if (indentOf(lines[j]) <= base) break;
          secrets.push(lines[j].trim());
          dropped.add(j);
        }
      } else if (info.value) {
        secrets.push(info.value);
      }
    }
    // 剥离后形如 `- textbox "密码" [ref=f2e7] [password]`，不带值（规格 §6.2）
    out[info.index] = `${info.head} [password]`;
  }

  let text = out.filter((_, i) => !dropped.has(i)).join('\n');

  // 返回前断言全文不含原值。这条是兜底：上面任何一处正则写歪，都会在这里被拦下，
  // 而不是把明文放出去。
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw actionBlocked('快照剥离自检失败，拒绝返回可能含明文的快照');
    }
  }

  // 逐节点判，不看正文。parsed 里没有 [ref=] 的行是 null（纯文本行），天然被跳过。
  const looksLikeCaptcha = parsed.some((p) => {
    if (!p || !CAPTCHA_ROLES.has(p.role)) return false;
    const name = p.head.toLowerCase();
    return CAPTCHA_HINTS.some((h) => name.includes(h));
  });
  if (looksLikeCaptcha) noteReason('captcha');

  return {
    snapshot: text,
    needsHuman: reason !== null,
    reason,
    sensitiveRefs,
  };
}

/**
 * act 前重取节点属性判定敏感 —— 不信任调用方传来的 ref 语义（规格 §7.1）。
 */
export async function isSensitiveRef(page, ref) {
  let info;
  try {
    info = await page
      .locator('aria-ref=' + ref)
      .evaluate((el) => ({
        type: el.type,
        ac: el.autocomplete,
        // 可访问名那一维在这儿得自己凑：这条路径不经过 ariaSnapshot，拿不到那份 YAML 的
        // head。取的是浏览器算可访问名时真正会看的那几处，够支付启发式用了。
        label: [
          el.getAttribute('aria-label'),
          el.labels?.[0]?.textContent,
          el.placeholder,
          el.name,
        ].filter(Boolean).join(' '),
      }));
  } catch {
    return true; // 判不了就当敏感，fail-closed
  }
  const ac = String(info.ac ?? '').toLowerCase();
  if (String(info.type ?? '').toLowerCase() === 'password') return true;
  for (const needle of SENSITIVE_AC.keys()) if (ac.includes(needle)) return true;
  // 和 takeStrippedSnapshot 里那条同一个判据。**两边必须一致**：快照那边把卡号框剥了、
  // act 这边却放行，等于剥离只是好看，模型照样能往里打字（这正是 2026-08-14 那次
  // 「只挡 fill、press 敞开」的形状）。这条路径故意不信任调用方，一律从 DOM 重取。
  if (looksLikePaymentName(info.label)) return true;
  return false;
}
