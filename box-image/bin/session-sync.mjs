#!/usr/bin/env node
// 登录态内存层：整机一份守护，经各屏回环调试口同步 cookie 和 localStorage。
//
// 只补缺，不覆盖已有值。覆盖会把刚轮换的短命登录 cookie 回滚成旧的，反而登出。
// 发现屏的方法：列 /tmp/.X11-unix/X<N>，口 = 9222+N。
//
// 不用 playwright —— 这里只需要 CDP 的 Storage 域和一句 Runtime.evaluate，裸 WebSocket
// 就够，而且这个守护要在没装 node_modules 的镜像里也能跑。
//
// 两层走的连接不是同一个：
//   - cookie   → browser 端点（`/json/version`），Storage 域是按浏览器的
//   - localStorage → **页面 target**（`/json/list` 里每页自带的 ws），因为它按 origin 存，
//     只有在那个 origin 的页面上下文里才读得到
// 实测过页面 target 这条连接和 box-service 的 playwright 可以并存（快照与 act 照常）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { writeLs } from './session-sync-page.mjs';

const CDP_BASE = 9222;
const INTERVAL_MS = 5000;
const WINDOW_SERVICE = 'http://127.0.0.1:18765/v1/screens';
const STATE_FILE = process.env.SAND_SESSION_SYNC_STATE_FILE;
const HANDOFF_FILE = path.join(process.env.SAND_AGENT_WORKSPACE || process.env.SAND_WORKSPACE_ROOT || '/workspace', '.grokbot/ask-human.json');

/**
 * 「从无到有」触发的重载，每 (浏览器实例, origin) 最多这么多次 —— **断路器**（规格 §9.3）。
 *
 * 没有它就是一个自激回路：页面一加载就清掉 localStorage 的站点（不少 SPA 在
 * 登出路径上就这么干），下一轮我们又给它补齐、又判定「从无到有」、又重载 ——
 * 每 5 秒一次，永远不停，而且人正在看的页面会一直跳。
 *
 * 计数存在模块级 Map 里，所以它只保护**长跑的守护**；`--once` 每次都是新进程，
 * 结构上碰不到这条路径（登记见规格 §11.1，S3 不覆盖它）。
 */
const RELOAD_CAP = 2;
const reloads = new Map(); // `${浏览器端点}|${origin}` -> 次数

function displays() {
  try {
    return fs.readdirSync('/tmp/.X11-unix')
      .filter((f) => /^X\d+$/.test(f))
      .map((f) => Number.parseInt(f.slice(1), 10));
  } catch { return []; }
}

function getJson(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 镜像里的 node 是 20.x，没有稳定的全局 WebSocket，用 ws 包
const { default: WebSocket } = await import('/usr/local/lib/node_modules/ws/index.js');

// 极简 CDP 客户端：一条连接发一批命令
async function cdp(wsUrl, commands, beforeSend) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const out = [];
    let i = 0;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(error); else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error('CDP 超时')), 5000);
    const send = async () => {
      if (i >= commands.length) { finish(); return; }
      try {
        // 建连期间状态也可能改变，发送变更命令前再检查一次。
        if (beforeSend && !await beforeSend()) { finish(); return; }
        if (!done) ws.send(JSON.stringify({ id: i + 1, ...commands[i] }));
      } catch (error) { finish(error); }
    };
    ws.onopen = send;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (error) { finish(error); return; }
      if (msg.id === i + 1 && msg.error) { finish(new Error(msg.error.message)); return; }
      if (msg.id === i + 1) { out.push(msg.result ?? null); i += 1; send(); }
    };
    ws.onerror = () => finish(new Error('CDP 连接失败'));
    ws.onclose = () => { if (!done) finish(new Error('CDP 连接提前关闭')); };
  });
}

const key = (c) => `${c.name}|${c.domain}|${c.path}`;

/**
 * 各屏当前状态，用来回答「这块屏忙不忙」（规格 §9.3：忙屏不重载）。
 *
 * 三种回答要分清，混起来会让重载路径要么永远不走、要么在人脸上乱跳：
 *   - 服务通、该显示号有行 → 用它的 state
 *   - 服务通、**没有那一行** → 当 idle。`start-window` 直接起的屏（门禁就是这么起的）
 *     不进窗口表，一律判忙的话重载路径就永远测不到；而生产里每块屏都有行。
 *   - 服务不通 → 返回 null，调用方一律**不重载**。拿不到状态时保守。
 */
async function screenStates() {
  return new Promise((resolve) => {
    const req = http.get(WINDOW_SERVICE, { timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try {
          const m = new Map();
          for (const s of JSON.parse(b).screens ?? []) m.set(Number(s.display), s.state);
          resolve(m);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 主宿主发布的状态必须新鲜且完整；文件缺失或接管期间保守停写。
async function mayMutate(display) {
  try { fs.lstatSync(HANDOFF_FILE); return false; }
  catch (error) { if (error.code !== 'ENOENT') return false; }
  if (STATE_FILE) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const age = Date.now() - s.updatedAt;
      return s.version === 1 && s.state === 'idle' && Number.isInteger(s.pid) && s.pid > 0
        && Number.isFinite(s.updatedAt) && age >= -1000 && age <= 15000;
    } catch { return false; }
  }
  const states = await screenStates();
  return states !== null && (states.get(display) === undefined || states.get(display) === 'idle');
}

// 页内读：origin 和全部 localStorage 键值。不可读（opaque origin、被策略挡住）就回 null，
// 让调用方跳过这一页，而不是把整轮同步弄崩。
const READ_LS = `(() => { try {
  return JSON.stringify([location.origin, Object.entries(localStorage)]);
} catch (e) { return null; } })()`;

/**
 * 页内写：**再查一次才补**。
 *
 * 不能信 Mac 侧刚读到的那份快照 —— 读和写之间隔着一次 CDP 往返，这中间页面自己
 * 可能刚写进同一个键（登录成功那一刻正是这样）。「只补缺、不覆盖」必须在**写入的
 * 那一刻**成立，否则就会把刚轮换的新值盖回旧的，表现为「刚登录又被登出」。
 *
 * 这是**第二道**：上面 syncLocalStorage 里算 `missing` 时已经滤过一遍。两道冗余，
 * 所以 S3 那条「已有键未被覆盖」只在**两道都破坏**时才红 —— 实测过（单破一道仍绿，
 * 因为不变量确实还成立；两道都破 → 恰好那一条红）。断言打的是不变量，不是实现，
 * 这是对的；但下次改这里时要知道：单元层面没有断言盯着这一道。
 */
async function evalIn(wsUrl, expression, beforeSend) {
  const r = await cdp(wsUrl, [{ method: 'Runtime.evaluate', params: { expression, returnByValue: true } }], beforeSend);
  if (r?.[0]?.exceptionDetails) throw new Error(r[0].exceptionDetails.text);
  return r?.[0]?.result?.value ?? null;
}

/**
 * localStorage 只补缺（规格 §9.3 第二层）。cookie 那半在 syncCookies 里，两者互不影响。
 *
 * 走**页面 target** 的调试连接（`/json/list` 里每页自带的 ws），不是 browser 端点：
 * localStorage 是按 origin 存的，只有在那个 origin 的页面上下文里才读得到。
 * 实测过这条连接和 box-service 的 playwright 可以并存（快照与 act 照常）。
 */
async function syncLocalStorage(live) {
  const pages = [];
  for (const b of live) {
    const list = await getJson(b.port, '/json/list');
    for (const t of list ?? []) {
      if (t.type !== 'page' || !/^https?:/i.test(t.url ?? '') || !t.webSocketDebuggerUrl) continue;
      const raw = await evalIn(t.webSocketDebuggerUrl, READ_LS);
      if (!raw) continue;
      let origin, entries;
      try { [origin, entries] = JSON.parse(raw); } catch { continue; }
      // 按**页内自报的 origin** 分组，不按 /json/list 里那个 url 推：列出来到 attach
      // 之间页面可能已经导航走了，那时两者对不上，这一页这一轮就跳过。
      let listedOrigin = null;
      try { listedOrigin = new URL(t.url).origin; } catch { /* 解析不了就当对不上 */ }
      if (origin !== listedOrigin) continue;
      pages.push({ display: b.n, browser: b.ws, ws: t.webSocketDebuggerUrl, origin, entries });
    }
  }
  if (pages.length < 2) return;

  // 按 origin 取并集；同一个键先到先得，和 cookie 那边同一条规则
  const unions = new Map();
  for (const p of pages) {
    if (!unions.has(p.origin)) unions.set(p.origin, new Map());
    const u = unions.get(p.origin);
    for (const [k, v] of p.entries) if (!u.has(k)) u.set(k, v);
  }

  let mirrored = 0;

  for (const p of pages) {
    const u = unions.get(p.origin);
    const have = new Set(p.entries.map(([k]) => k));
    const missing = [...u.entries()].filter(([k]) => !have.has(k));
    if (!missing.length) continue;

    // 忙时连写入一起延后，保留下一轮空页初始化及重载的机会。
    if (!await mayMutate(p.display)) continue;
    const rk = `${p.browser}|${p.origin}`;
    const n = reloads.get(rk) ?? 0;
    // 发送后断连时无法确认页面是否已刷新，先消耗本次预算。
    if (n < RELOAD_CAP && p.entries.length === 0) reloads.set(rk, n + 1);
    const result = await evalIn(p.ws, writeLs(p.origin, missing, n < RELOAD_CAP), () => mayMutate(p.display));
    if (result?.error) throw new Error(result.error);
    const wrote = result?.wrote ?? 0;
    mirrored += wrote;
    if (result?.reloaded) {
      reloads.set(rk, n + 1);
      console.error(`[sync] :${p.display} ${p.origin} 从无到有补了 ${wrote} 个键，已重载`);
    }
  }

  if (mirrored) {
    console.error(`[sync] mirrored ${mirrored} localStorage write(s) across ${pages.length} page(s)`);
  }
}

async function syncOnce() {
  const live = [];
  for (const n of displays()) {
    const port = CDP_BASE + n;
    const v = await getJson(port, '/json/version');
    if (v?.webSocketDebuggerUrl) live.push({ n, port, ws: v.webSocketDebuggerUrl });
  }
  if (live.length < 2) return;
  for (const rk of reloads.keys()) {
    if (!live.some((b) => rk.startsWith(`${b.ws}|`))) reloads.delete(rk);
  }

  await syncCookies(live);
  // cookie 已先完成；后续失败继续向上传递，让单轮探针得到真实退出码。
  await syncLocalStorage(live);
}

async function syncCookies(live) {
  // 各屏的 cookie 罐
  const jars = [];
  for (const b of live) {
    const r = await cdp(b.ws, [{ method: 'Storage.getCookies', params: {} }]);
    jars.push({ ...b, cookies: r?.[0]?.cookies ?? [] });
  }

  // 并集 → 逐屏只补自己没有的键
  const union = new Map();
  for (const j of jars) for (const c of j.cookies) if (!union.has(key(c))) union.set(key(c), c);

  let mirrored = 0;
  for (const j of jars) {
    if (!await mayMutate(j.n)) continue;
    const [latest] = await cdp(j.ws, [{ method: 'Storage.getCookies', params: {} }]);
    const have = new Set((latest?.cookies ?? []).map(key));
    const missing = [...union.values()].filter((c) => !have.has(key(c)));
    if (!missing.length) continue;
    if (!await mayMutate(j.n)) continue;
    const written = await cdp(j.ws, [{ method: 'Storage.setCookies', params: { cookies: missing } }], () => mayMutate(j.n));
    if (written.length) mirrored += missing.length;
  }
  if (mirrored) {
    console.error(`[sync] mirrored ${mirrored} cookie write(s) across ${jars.length} monitors`);
  }
}

// `--once` 跑一轮就退出。**这个模式是给门禁 S3 用的**，不是调试便利：
// 没有它，探针就只能自己再实现一遍「只补缺」的合并再断言自己的实现 —— 那样把这个文件
// 整个删掉 S3 照样绿（2026-08-14 code review 查出，探针当时正是这么写的）。
// 断言必须打到被断言的东西本身。
if (process.argv[2] === '--once') {
  await syncOnce();
  process.exit(0);
}

console.error('[sync] mirroring cookies + localStorage across box monitors (只补缺)');
// 等本轮结束再计时，避免慢连接让多个同步轮次交错写入。
while (true) {
  try { await syncOnce(); } catch (error) { console.error(`[sync] 同步失败：${error.message}`); }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
