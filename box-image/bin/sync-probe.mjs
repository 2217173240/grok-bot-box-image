#!/usr/bin/env node
// S3 探针：会话同步遇到对方已有的 cookie 键时，必须不覆盖。
//
// 造局：A 屏和 B 屏都有 shared，值不同；A 还独有 onlyA。
// 期望：同步后 B 的 shared 保持自己的旧值，onlyA 被补齐。
//
// **被测对象是 session-sync.mjs 本身**，这里只造局和断言，中间那一步调它的 --once。
// 早先的版本在这里自己实现了一遍「只补缺」的合并再断言自己的结果 —— 那样 S3 是假绿的，
// 把 session-sync.mjs 删掉它照样通过。断言要打到被断言的东西本身。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLs } from './session-sync-page.mjs';
const { default: WebSocket } = await import('/usr/local/lib/node_modules/ws/index.js');

const [, , portA = '9224', portB = '9225'] = process.argv;
const DOMAIN = '127.0.0.1';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-probe-'));
const stateFile = path.join(testRoot, 'activity.json');
const handoffFile = path.join(testRoot, '.grokbot/ask-human.json');
process.on('exit', () => fs.rmSync(testRoot, { recursive: true, force: true }));
const publish = (state, updatedAt = Date.now()) => {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ version: 1, state, updatedAt, pid: process.pid }));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
};
publish('idle');

// 异步等待子进程，让本进程的真实 HTTP 站点持续响应页面导航。
const runSync = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['/usr/local/bin/session-sync.mjs', '--once'], {
    env: { ...process.env, SAND_SESSION_SYNC_STATE_FILE: stateFile, SAND_AGENT_WORKSPACE: testRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  child.once('close', (status) => { clearTimeout(timeout); resolve({ status, stderr }); });
});

/**
 * 「前置没满足、一条断言都没跑」的退出码。
 *
 * **必须挑一个不可能和失败条数撞上的数。** 上一版用的是 3，而收尾是
 * `process.exit(fail)` —— 断言一加多，恰好红 3 条时 gates.sh 就会把一次真实的失败
 * 读成「没跑」。负向验证时真撞上了：换回只搬 cookie 的守护，正好红 3 条。
 * 失败一律归一成 1，条数由 gates.sh 数 ✓/✗ 行来记。
 */
const SKIP_CODE = 90;

const getJson = (port, path) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

async function cdp(ws, commands) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws); const out = []; let i = 0;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.terminate();
      if (error) reject(error); else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error('探针 CDP 超时')), 5000);
    const send = () => {
      if (i >= commands.length) { finish(); return; }
      sock.send(JSON.stringify({ id: i + 1, ...commands[i] }));
    };
    sock.on('open', send);
    sock.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.id === i + 1 && m.error) { finish(new Error(m.error.message)); return; }
      if (m.id === i + 1) { out.push(m.result ?? null); i += 1; send(); }
    });
    sock.on('error', finish);
    sock.on('close', () => { if (!done) finish(new Error('探针 CDP 连接提前关闭')); });
  });
}

const cookie = (name, value) => ({ name, value, domain: DOMAIN, path: '/' });

const a = await getJson(portA, '/json/version');
const b = await getJson(portB, '/json/version');
if (!a?.webSocketDebuggerUrl || !b?.webSocketDebuggerUrl) {
  // **退 3，不退 0。** 退 0 的那一版是条假绿：gates.sh 的判据是退出码，
  // `if node sync-probe.mjs; then PASS=$((PASS+2))` —— 于是零条断言换两分绿，
  // 账面还涨了 2，比不测更糟。而这条路径不是理论情形：S3 是全份门禁里唯一开到
  // 第三块屏的用例，而规格 §4.6 自陈「并发上限约 3–4 块屏」、doctor 也写着
  // 「2 核 3GB 开第三块屏直接 OOM」—— 内存一紧，S3 就静默消失。
  const down = [!a?.webSocketDebuggerUrl && portA, !b?.webSocketDebuggerUrl && portB].filter(Boolean);
  console.log(`  ✗ S3 没跑成：CDP ${down.join(' 和 ')} 探不到（第三块屏的浏览器没起来？内存不够？）`);
  process.exit(SKIP_CODE);
}

// 先清罐再造局。不清的话第二次跑时 onlyA 是上一轮的残留，
// 「缺失键已补齐」会被残留满足 —— 又是一条不依赖被测对象的假绿。
await cdp(a.webSocketDebuggerUrl, [{ method: 'Storage.clearCookies', params: {} }]);
await cdp(b.webSocketDebuggerUrl, [{ method: 'Storage.clearCookies', params: {} }]);

await cdp(a.webSocketDebuggerUrl, [{ method: 'Storage.setCookies',
  params: { cookies: [cookie('shared', 'A-new'), cookie('onlyA', '1')] } }]);
await cdp(b.webSocketDebuggerUrl, [{ method: 'Storage.setCookies',
  params: { cookies: [cookie('shared', 'B-old')] } }]);

// **跑真的守护**，不要在这里重新实现一遍「只补缺」。
//
// 这个探针以前就是自己 union / filter 一遍再断言自己的结果 —— 于是把 session-sync.mjs
// 整个删掉 S3 照样绿，等于什么都没测（2026-08-14 code review 查出）。
// 现在调它的 --once 模式：跑一轮、退出、我们只看它留下的 cookie 罐。
const sync = await runSync();
if (sync.status !== 0) {
  console.log(`  ✗ S3 session-sync --once 退出码 ${sync.status}：${(sync.stderr ?? '').trim().slice(-200)}`);
  process.exit(1);
}

const [after] = await cdp(b.webSocketDebuggerUrl, [{ method: 'Storage.getCookies', params: {} }]);
const jar = after?.cookies ?? [];
const shared = jar.find((c) => c.name === 'shared');
let fail = 0;
const ok = (m) => console.log(`  ✓ S3 ${m}`);
const no = (m) => { console.log(`  ✗ S3 ${m}`); fail += 1; };
if (shared?.value === 'B-old') ok('cookie 已有键未被覆盖');
else no(`cookie 已有键被覆盖成 ${shared?.value}`);
if (jar.some((c) => c.name === 'onlyA')) ok('cookie 缺失键已补齐');
else no('cookie 缺失键没补上');

// ---------------------------------------------------------------------------
// localStorage 那一层（规格 §9.3 第二层的另一半）
//
// 以前这个探针只造 cookie 局、只读 cookie 罐，于是 §9.3 白纸黑字要求的
// 「cookie **和 localStorage** 只补缺」里的后半截结构上测不到 —— 而实现那边也确实
// 只搬了 cookie，注释还写着「同步 cookie 和 localStorage」。注释说了、代码没做。
//
// localStorage 是按 origin 存的，所以得让两只浏览器真的停在同一个 origin 的页面上。
// 探针自己起一个小 HTTP 服务当那个 origin，顺带**数每块屏加载了几次** —— 重载断言
// 就靠它，而不是往页面里塞一个计数变量（那玩意儿一重载就没了）。
// ---------------------------------------------------------------------------

const loads = new Map(); // display -> 次数
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/p?')) { res.writeHead(204); res.end(); return; }
  const d = new URL(req.url, 'http://127.0.0.1').searchParams.get('d') ?? '?';
  loads.set(d, (loads.get(d) ?? 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  const clear = new URL(req.url, 'http://127.0.0.1').searchParams.has('clear');
  res.end(`<html><head><meta charset="utf-8"><title>s3</title>${clear ? '<script>localStorage.clear()</script>' : ''}</head><body>s3</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const originPort = server.address().port;
const ORIGIN = `http://127.0.0.1:${originPort}`;

/** 取该浏览器的第一个页面 target 的 ws。localStorage 只能在页面上下文里读写。 */
async function pageWs(port) {
  const list = await getJson(port, '/json/list');
  const t = (list ?? []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  return t?.webSocketDebuggerUrl ?? null;
}
const evalIn = async (ws, expression) => {
  const r = await cdp(ws, [{ method: 'Runtime.evaluate', params: { expression, returnByValue: true } }]);
  if (r?.[0]?.exceptionDetails) throw new Error(r[0].exceptionDetails.text);
  return r?.[0]?.result?.value ?? null;
};
const readLs = (ws) => evalIn(ws, `JSON.stringify(Object.entries(localStorage))`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wsA = await pageWs(portA);
const wsB = await pageWs(portB);
if (!wsA || !wsB) {
  no('两屏里找不到可用的页面 target，localStorage 那半没跑');
} else {
  // 两块屏停在**同一个 origin**（localStorage 按 origin 存），但 query 不同，好分别计数
  await cdp(wsA, [{ method: 'Page.enable', params: {} }, { method: 'Page.navigate', params: { url: `${ORIGIN}/p?d=A` } }]);
  await cdp(wsB, [{ method: 'Page.enable', params: {} }, { method: 'Page.navigate', params: { url: `${ORIGIN}/p?d=B` } }]);
  await sleep(1500);

  // 第一局：A 有 shared + onlyA，B 有自己的 shared。期望「补齐 onlyA、不覆盖 shared」。
  await evalIn(wsA, `localStorage.clear(); localStorage.setItem('shared','A-new'); localStorage.setItem('onlyA','1'); 1`);
  await evalIn(wsB, `localStorage.clear(); localStorage.setItem('shared','B-old'); 1`);
  const beforeLoads = new Map(loads);

  publish('idle');
  const s1 = await runSync();
  if (s1.status !== 0) no(`localStorage 局的 session-sync --once 退出码 ${s1.status}`);
  await sleep(500);

  const bItems = new Map(JSON.parse((await readLs(wsB)) ?? '[]'));
  if (bItems.get('shared') === 'B-old') ok('localStorage 已有键未被覆盖');
  else no(`localStorage 已有键被覆盖成 ${bItems.get('shared')}`);
  if (bItems.get('onlyA') === '1') ok('localStorage 缺失键已补齐');
  else no('localStorage 缺失键没补上');
  // B 本来就有值 → 属于「补缺」，不该重载。**只断言 B 没多加载**，
  // 不断言绝对次数：真守护每 5 秒 tick 一次，会和探针交错。
  if ((loads.get('B') ?? 0) === (beforeLoads.get('B') ?? 0)) ok('已有值的页不重载（只是补缺）');
  else no('已有值的页被重载了');

  // 第二局：把 B 清空 → 这才是「从无到有」，该重载。
  await evalIn(wsB, `localStorage.clear(); 1`);
  const midB = loads.get('B') ?? 0;
  const midA = loads.get('A') ?? 0;
  publish('idle');
  const s2 = await runSync();
  if (s2.status !== 0) no(`从无到有局的 session-sync --once 退出码 ${s2.status}`);
  await sleep(1500);

  const bAfter = new Map(JSON.parse((await readLs(wsB)) ?? '[]'));
  if (bAfter.get('shared') === 'A-new' && bAfter.get('onlyA') === '1') ok('清空后整份补齐（从无到有）');
  else no(`清空后没补齐（拿到 ${JSON.stringify([...bAfter])}）`);
  // 判据写成「B 至少多加载一次、A 一次都没多」，不写死次数：背景守护同样会做这件事，
  // 谁先跑到结果一样（并集合并是幂等的）。A 是种子方，永远不会经历零→非零，
  // 所以「A 没重载」对背景 tick 免疫，正好把「重载只在从无到有时发生」钉住。
  if ((loads.get('B') ?? 0) > midB) ok('从无到有的页被重载了');
  else no('从无到有的页没有重载');
  if ((loads.get('A') ?? 0) === midA) ok('本来就有值的那块屏自始至终没被重载');
  else no('本来就有值的那块屏也被重载了');

  // 每种阻断状态都必须保留空页，恢复新鲜 idle 后仍能补齐并重载。
  for (const mode of ['busy', 'missing', 'stale', 'future', 'malformed', 'handoff']) {
    await evalIn(wsB, `localStorage.clear(); 1`);
    const before = loads.get('B') ?? 0;
    publish('idle');
    if (mode === 'busy') publish('busy');
    if (mode === 'missing') fs.unlinkSync(stateFile);
    if (mode === 'stale') publish('idle', Date.now() - 20000);
    if (mode === 'future') publish('idle', Date.now() + 60000);
    if (mode === 'malformed') fs.writeFileSync(stateFile, '{');
    if (mode === 'handoff') {
      fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
      fs.writeFileSync(handoffFile, '{');
    }
    const blocked = await runSync();
    await sleep(200);
    if (blocked.status === 0 && await readLs(wsB) === '[]' && (loads.get('B') ?? 0) === before) ok(`${mode} 阻止写入及重载`);
    else no(`${mode} 未能阻止写入及重载：${blocked.stderr.slice(-200)}`);
    fs.rmSync(handoffFile, { force: true });
    publish('idle');
    const recovered = await runSync();
    await sleep(500);
    const recoveredItems = new Map(JSON.parse((await readLs(wsB)) ?? '[]'));
    if (recovered.status === 0 && recoveredItems.get('onlyA') === '1' && (loads.get('B') ?? 0) > before) ok(`${mode} → idle 后补齐并重载`);
    else no(`${mode} → idle 后未恢复：${recovered.stderr.slice(-200)}`);
  }

  // 真导航到另一个 origin，再执行生产使用的表达式，验证旧来源数据没有泄漏。
  const otherServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>other origin</body></html>');
  });
  await new Promise((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  try {
    await cdp(wsB, [{ method: 'Page.navigate', params: { url: `http://127.0.0.1:${otherServer.address().port}/` } }]);
    await sleep(500);
    await evalIn(wsB, `localStorage.clear(); 1`);
    const guarded = await evalIn(wsB, writeLs(ORIGIN, [['origin-secret', 'seed']], true));
    if (guarded?.wrote === 0 && await readLs(wsB) === '[]') ok('导航到不同 origin 后生产写入表达式拒绝旧来源数据');
    else no('导航后旧来源数据写进了错误 origin');
  } finally { otherServer.close(); }

  // 页面每次加载主动清空，实际常驻守护应只触发两次重载，随后只补值。
  await cdp(wsB, [{ method: 'Page.navigate', params: { url: `${ORIGIN}/p?d=B&clear=1` } }]);
  await sleep(500);
  const capStart = loads.get('B') ?? 0;
  publish('idle');
  const heartbeat = setInterval(() => publish('idle'), 3000);
  const daemon = spawn(process.execPath, ['/usr/local/bin/session-sync.mjs'], {
    env: { ...process.env, SAND_SESSION_SYNC_STATE_FILE: stateFile, SAND_AGENT_WORKSPACE: testRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonError = null;
  let daemonStderr = '';
  daemon.once('error', (error) => { daemonError = error; });
  daemon.stderr.on('data', (chunk) => { daemonStderr += chunk; });
  const daemonClosed = new Promise((resolve) => daemon.once('close', resolve));
  try {
    await sleep(18000);
    const reloadCount = (loads.get('B') ?? 0) - capStart;
    const cappedItems = new Map(JSON.parse((await readLs(wsB)) ?? '[]'));
    if (!daemonError && daemon.exitCode === null && reloadCount === 2 && cappedItems.get('onlyA') === '1') ok('常驻守护最多重载两次，达到上限后仍可补缺');
    else no(`常驻重载上限异常：次数=${reloadCount}，错误=${daemonError?.message ?? daemonStderr.slice(-200)}`);
  } finally {
    clearInterval(heartbeat);
    daemon.kill('SIGTERM');
    await daemonClosed;
  }
}
server.close();
process.exit(fail ? 1 : 0);
