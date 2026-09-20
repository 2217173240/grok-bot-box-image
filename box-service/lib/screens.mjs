// 窗口表 + owner token + 屏状态机。这是整个系统的唯一权威（规格 §3）。
//
// 为什么权威在容器里：agent CLI 普遍用 stdio 传输，等于每个 client 一个 MCP server 进程。
// 窗口表放 MCP server 里就是每进程一份，两只 agent 会各自 mint token 去抢同一块屏。

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as db from './db.mjs';
import {
  PRIMARY_DISPLAY, MAX_DISPLAY, MAX_SCREENS, AWAITING_HUMAN_MS, VNC_BASE,
} from './config.mjs';
import { issue as issueView, current as currentView, novncUrlFor } from './novnc-auth.mjs';
import { runScript } from './run.mjs';
import { forbidden, busy, gone, badRequest, tooManyScreens, internal } from './errors.mjs';
import { dropConnection, ensureChromium } from './browser.mjs';
import { assertUsableAsPath, ensureScreenDir } from './workspace.mjs';
import { currentCaller, occupantKey } from './caller.mjs';

const TOKEN_DIR = '/tmp/sand-window-tokens.d';

export const STATES = ['starting', 'idle', 'driving_page', 'awaiting_human', 'stopping'];

const timers = new Map(); // name -> 15 分钟接管超时
const locks = new Map(); // name -> Promise，同屏动作串行

// 日志里 token 只记前后 4 位（规格 §9.1）
export const mask = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '(空)');

const now = () => new Date().toISOString();

// 32 字节 crypto 随机 hex。mint 在容器里，消费也在容器里，绝不出现在任何 HTTP 响应里。
const mintToken = () => crypto.randomBytes(32).toString('hex');

export function log(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

export async function audit(screen, action, requestId) {
  // fill 只记 action，不记 text（规格 §10）
  try {
    await db.exec(
      'INSERT INTO audit(screen, action, request_id, ts, client) VALUES($screen,$action,$rid,$ts,$client)',
      // client 从请求上下文里取，不走参数：它只有这一处用得到，没必要穿过十来层签名。
      // 值是**自报的**，只为区分几个善意 agent，不是鉴权（见 caller.mjs）。
      { screen, action, rid: requestId ?? '', ts: now(), client: currentCaller() }
    );
  } catch (e) {
    log('审计写入失败（不影响主流程）：', e.message);
  }
}

export async function getActive(name) {
  return db.get(
    "SELECT * FROM screens WHERE name=$name AND status='active'",
    { name }
  );
}

export async function listActive() {
  return db.all("SELECT * FROM screens WHERE status='active' ORDER BY display");
}

async function setState(name, state) {
  await db.exec('UPDATE screens SET state=$state WHERE name=$name', { name, state });
}

async function allocDisplay() {
  const rows = await db.all("SELECT display FROM screens WHERE status='active'");
  const used = new Set(rows.map((r) => Number(r.display)));
  for (let n = PRIMARY_DISPLAY + 1; n <= MAX_DISPLAY; n++) {
    if (!used.has(n)) return n;
  }
  throw internal(`没有空闲显示号（上限 :${MAX_DISPLAY}）`);
}

// 恒定时间比对 owner 文件，语义和窗口路由器一致：没有文件 / 空文件 = 未绑定 = 拒绝。
function ownerFileMatches(display, token) {
  let expected;
  try {
    expected = fs.readFileSync(`${TOKEN_DIR}/${display}`);
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const got = Buffer.from(token ?? '', 'utf8');
  if (got.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(expected, got);
}

/**
 * 开屏，并处理退出码 75。
 * 75 = 屏活着但 token 不是自己的。处理：stop-window → mint 新 token → 重试一次（规格 §5.3）。
 * 只重试一次，不循环 —— 连续两次 75 说明有别的东西在抢这块屏，重试只会互相踩。
 */
async function startWindowWithRetry(name, display, token) {
  let cur = token;
  let r = await runScript('start-window', [String(display), cur]);
  if (r.code === 75) {
    log(`:${display} start-window 退出 75，拆掉重开（旧 token ${mask(cur)}）`);
    await dropConnection(display);
    await runScript('stop-window', [String(display)]);
    cur = mintToken();
    await db.exec('UPDATE screens SET token=$token WHERE name=$name', { name, token: cur });
    r = await runScript('start-window', [String(display), cur]);
  }
  if (r.code !== 0) {
    throw internal(`start-window :${display} 失败（code=${r.code}）：${r.stderr.trim().slice(-300)}`);
  }
  return cur;
}

/** create_screen。幂等：同名已存在且活着 → 直接返回。 */
export async function createScreen(name, requestId, { steal = false } = {}) {
  if (!name || typeof name !== 'string' || name.length > 64) {
    throw badRequest('screen 必须是 1..64 字符的字符串');
  }
  // 屏名从这一版起还要当目录名和 shell 的 cwd 用（规格 §4.6 的每屏工作区），
  // 所以它是**不可信输入**：`../` 一进来就能写到工作区外面去，比如全机登录态所在的
  // /home/box/chrome-profile。校验放在这里 —— 窗口服务是唯一权威，CLI 只是入口之一。
  assertUsableAsPath(name);
  return withLock(name, async () => {
    let row = await getActive(name);
    const fresh = !row; // 新建的屏失败要回滚，不能把显示号泄漏成一行永远 starting 的死记录
    if (!row) {
      // **数量闸（规格 §4.6）。** MAX_DISPLAY=9 是端口公式的上限，不是内存撑得住的数：
      // 容器空载 200MB、每只 Chromium 约 800MB、OrbStack 默认给 8GB —— 真开到 9 块会先
      // OOM，而 OOM 是整只容器一起死，连**别人**那几块正在用的屏一起带走。
      //
      // 闸放在 allocDisplay 之前、且只拦新建：同名 reattach 必须照常通过（E10 的语义，
      // 也是「会话重启后复用同一块屏」这个核心特性）。拒在这儿是零成本的 ——
      // Xvfb 和 Chromium 都还没起。
      // 注意闸的**先后**：assertUsableAsPath 在 withLock 之外、比这里早，所以屏数到顶时
      // 恶意屏名拿到的仍然是 BAD_REQUEST 而不是这个码 —— E19 那四条路径穿越断言不会被
      // 数量闸顶替掉（两个码分开的第二个理由，见 errors.mjs）。
      const active = await listActive();
      if (active.length >= MAX_SCREENS) {
        throw tooManyScreens(
          `已经开着 ${active.length} 块屏，到上限 ${MAX_SCREENS} 了（内存撑不住更多）。` +
          `先 destroy_screen 掉不用的那块再来：${active.map((r) => r.name).join('、')}`
        );
      }
      const display = await allocDisplay();
      const token = mintToken();
      // 同名的 revoked 旧行直接顶掉：屏名可 reattach 的语义只针对活行
      await db.exec(
        `INSERT OR REPLACE INTO screens(name, display, token, state, created_at, status, occupant)
         VALUES($name,$display,$token,'starting',$ts,'active',$occupant)`,
        { name, display, token, ts: now(), occupant: occupantKey() }
      );
      row = { name, display, token, state: 'starting', occupant: occupantKey() };
      log(`分配 ${name} → :${display}，token ${mask(token)}`);
    } else {
      const holder = occupantKey(row.occupant || '');
      const who = occupantKey();
      if (holder && who && holder !== who && !steal) {
        throw forbidden(
          `屏 ${name} 已被 ${holder} 占用。同一路 client 才能复用；要抢，显式 steal=true`
        );
      }
      if (holder && who && holder !== who && steal) {
        await db.exec('UPDATE screens SET occupant=$occupant WHERE name=$name', { name, occupant: who });
        await audit(name, 'steal', requestId);
        log(`${name} 被 ${who} steal（原占用 ${holder}）`);
        row = { ...row, occupant: who };
      } else if (!holder && who) {
        await db.exec('UPDATE screens SET occupant=$occupant WHERE name=$name', { name, occupant: who });
        row = { ...row, occupant: who };
      }
      await setState(name, row.state === 'awaiting_human' ? 'awaiting_human' : 'starting');
    }

    const display = Number(row.display);
    let token;
    try {
      token = await startWindowWithRetry(name, display, row.token);
      // Chromium 按需起，起不来算 create 失败（规格 §6.1：起 Chromium 是 create 的一部分）
      await ensureChromium(display);
    } catch (e) {
      if (fresh) {
        // starting → [*] 失败（规格 §5.2）。把屏拆干净并撤掉绑定，显示号才能重新分配。
        await runScript('stop-window', [String(display)]).catch(() => {});
        await db.exec(
          "UPDATE screens SET status='revoked', state='stopping', token='' WHERE name=$name",
          { name }
        );
      }
      // 已有的屏没起来不撤绑定：绑定丢了 = 调用方的屏名连同登录态一起没了，重试更划算
      throw e;
    }

    const state = row.state === 'awaiting_human' ? 'awaiting_human' : 'idle';
    await setState(name, state);
    // 接管中的屏被 reattach：只在没有计时器时补一个（进程重启的情形，recover 也管这件事）。
    // 不能无条件重置，否则调用方反复 create_screen 就能把一块屏永久占在 awaiting_human。
    if (state === 'awaiting_human' && !hasTimer(name)) armTimer(name);
    // 每屏一格工作区（规格 §4.6）。幂等，reattach 回到同一个目录 —— 文件的持久语义
    // 和登录态一致，都挂在屏名上。建不出来不算 create 失败，如实返回 null。
    const workspace = await ensureScreenDir(name);
    // 画面凭证：新建签发，reattach 复用还活着的那张。不在每次 create 轮换 ——
    // 否则人正看着的 noVNC 会被同名 reattach 踢掉。
    if (!currentView(display)) issueView(display);
    await audit(name, 'create_screen', requestId);
    log(`${name} 就绪 :${display}（token ${mask(token)}）`);
    return { screen: name, display, state, novncUrl: novncUrlFor(display), workspace };
  });
}

/** destroy_screen。stop-window 后把 token 标 revoked、删绑定。 */
export async function destroyScreen(name, requestId) {
  const row = await getActive(name);
  if (!row) throw gone(`屏 ${name} 不存在`);
  return withLock(name, async () => {
    clearTimer(name);
    await setState(name, 'stopping');
    const display = Number(row.display);
    await dropConnection(display);
    // stop-window 自己拒 N≤1，这里不重复实现（规格 §7.1）
    const r = await runScript('stop-window', [String(display)]);
    if (r.code !== 0) log(`stop-window :${display} 返回 ${r.code}，仍然按拆除处理`);
    // token 置空 = 吊销：绑定没了，旧 token 无法重放
    await db.exec(
      "UPDATE screens SET status='revoked', state='stopping', token='' WHERE name=$name",
      { name }
    );
    // **工作区目录不删**（规格 §4.6）。和 `reset --hard` 放过工作区是同一条：
    // 屏是机器状态，拆了能重建；目录里是人和 agent 的产物，误删没有下一次。
    // 同名重建会回到同一个目录，正好接着上次干。
    await audit(name, 'destroy_screen', requestId);
    log(`${name} (:${display}) 已拆除（工作区目录保留）`);
    return { ok: true, screen: name, state: 'stopping' };
  });
}

/**
 * 状态闸门。规格 §7.1：awaiting_human 期间拒绝 open / act / snapshot / screenshot，
 * 且判定要**先于任何参数校验** —— 接管窗口正是屏上有密码 / OTP / 卡号的时刻。
 * 放行的只有 list_screens / human_release / destroy_screen。
 *
 * @param {'page'|'always'} mode page = 受闸；always = 不受闸
 */
export async function gate(name, mode) {
  const row = await getActive(name);
  if (!row) throw gone(`屏 ${name} 不存在或已拆`);
  if ((mode === 'page' || mode === 'workspace-write') && row.state === 'awaiting_human') {
    throw busy(`屏 ${name} 正在人工接管中`);
  }
  if (mode === 'page' || mode === 'workspace-write' || mode === 'workspace-read') {
    const holder = occupantKey(row.occupant || '');
    const who = occupantKey();
    if (holder && who && holder !== who) {
      throw forbidden(`屏 ${name} 正由 ${holder} 占用，当前是 ${who}`);
    }
  }
  if (mode === 'page' && !ownerFileMatches(Number(row.display), row.token)) {
    // 窗口表说这屏是我们的，但屏上的 owner 文件对不上：可能被人手工拆过或抢过。
    // fail-closed，别驱动一块不属于自己的浏览器。
    throw forbidden(`屏 ${name} 的 owner 校验不通过`);
  }
  return row;
}

/** 同屏动作串行。并发的两个 act 会排队而不是互相踩；排队时长由请求级超时兜底。 */
export function withLock(name, fn) {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(name, next.then(() => {}, () => {}));
  return next;
}

export function armTimer(name) {
  clearTimer(name);
  const t = setTimeout(async () => {
    timers.delete(name);
    try {
      const row = await getActive(name);
      if (row?.state !== 'awaiting_human') return;
      await setState(name, 'idle');
      await audit(name, 'awaiting_human_timeout', null);
      log(`${name} 接管超时 15 分钟，自动回 idle`);
    } catch (e) {
      log('接管超时处理失败：', e.message);
    }
  }, AWAITING_HUMAN_MS);
  t.unref?.();
  timers.set(name, t);
}

export function hasTimer(name) { return timers.has(name); }

export function clearTimer(name) {
  const t = timers.get(name);
  if (t) clearTimeout(t);
  timers.delete(name);
}

/** 转 awaiting_human。快照检出敏感节点、以及 ask_human 都走这里。 */
export async function toAwaitingHuman(name, reason, requestId) {
  await setState(name, 'awaiting_human');
  armTimer(name);
  // 进接管就轮换画面凭证：旧 URL 立刻失效，ask_human / 自动翻转拿到的是新的。
  const row = await getActive(name);
  if (row) issueView(Number(row.display));
  await audit(name, `awaiting_human:${reason ?? 'other'}`, requestId);
}

export async function release(name, requestId) {
  const row = await getActive(name);
  if (!row) throw gone(`屏 ${name} 不存在`);
  clearTimer(name);
  await setState(name, 'idle'); // 不重放任何输入（规格 §6.4）
  await audit(name, 'human_release', requestId);
  return { screen: name, state: 'idle' };
}

export async function markDriving(name) { await setState(name, 'driving_page'); }
export async function markIdle(name) { await setState(name, 'idle'); }

/**
 * 探活一块屏（规格 §5.4）。**两条必须同时成立**：
 *
 *   1. owner 文件存在且与窗口表里的 token 相等；
 *   2. 容器内 `5900+N` 可连（x11vnc 是桌面栈启动序的第 3 步）。
 *
 * 只查第一条会静默放行死屏：`/tmp` 在 overlay 上，**`docker restart` 之后 owner 文件
 * 还在、X 和 x11vnc 都已经没了**（实测，《可行性实测》坑 10）。而 `mac-bot up` 对已存在的
 * 停止容器走的正是 `docker start`，所以这是日常路径，不是边角情况。
 *
 * 用端口而不是进程名，是本项目一以贯之的纪律 —— `pgrep -f` 会匹配到自己所在的命令行。
 */
function vncPortOpen(display, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: VNC_BASE + Number(display) });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function screenIsAlive(row) {
  if (!ownerFileMatches(Number(row.display), row.token)) return false;
  return vncPortOpen(row.display);
}

/**
 * 启动自愈：
 *
 *   a) 和现实对账（规格 §5.4）：探活失败的 active 行 best-effort 拆干净后标 revoked。
 *      不这么做的话，容器死过一次之后 `list_screens` 会报告一块并不存在的屏为 idle、
 *      给出连不上的 novncUrl，awaiting_human 的死行还会被重新武装计时器并让 MCP server
 *      对着死地址弹浏览器；显示号也会被幽灵长期占着，反复崩溃能耗尽 MAX_DISPLAY 的槽位。
 *
 *      这不违反 §5.1 的「回收只能显式 destroy_screen」—— 那条保护的是**活屏**，
 *      而登录态在主 profile 里（§10.1），`create_screen(同名)` 之后照样拿得回来。
 *
 *   b) 活下来的行按老规矩归位：停在 starting/stopping/driving_page 的拨回 idle，
 *      仍在 awaiting_human 的重新武装 15 分钟超时。
 *
 * 表结构（规格 §10）没有 state_changed_at，所以只能重新计时，不能续算 —— 宁可多等，
 * 也不擅自加列偏离规格。
 */
export async function recover() {
  const rows = await listActive();
  for (const r of rows) {
    if (!(await screenIsAlive(r))) {
      // 先拆残留（owner 文件、noVNC token 登记），再撤绑定。顺序照规格 §4 的关屏纪律。
      await runScript('stop-window', [String(r.display)]).catch(() => {});
      await db.exec(
        "UPDATE screens SET status='revoked', state='stopping', token='' WHERE name=$name",
        { name: r.name }
      );
      await audit(r.name, 'recover_revoked', null);
      log(`对账：${r.name} (:${r.display}) 探活失败，容器多半重启过 —— 撤销绑定。` +
          `调用方 create_screen("${r.name}") 可重新建屏，登录态在主 profile 里没丢`);
      continue;
    }

    if (r.state === 'awaiting_human') {
      armTimer(r.name);
      log(`恢复：${r.name} 仍在 awaiting_human，重新计时 15 分钟`);
    } else if (r.state !== 'idle') {
      await setState(r.name, 'idle');
      log(`恢复：${r.name} 状态 ${r.state} → idle`);
    }
  }
}
