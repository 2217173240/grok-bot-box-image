#!/usr/bin/env node
// 容器内窗口服务 :18765 —— 系统的唯一权威（《规格-MVP-v1》§3）。
//
// HTTP 面一一对应规格 §6 的九个工具。Mac 侧的 MCP server 是无状态薄代理，
// 所有纪律（§7）在这一层强制，不靠调用方自觉：连上来的可能是任意第三方 client。
//
// 容器内绑 0.0.0.0（理由见 lib/config.mjs：docker-proxy 从容器 eth0 进来，绑回环则 Mac 侧
// 永远连不上）。隔离边界是容器的网络命名空间 + 宿主机只 publish 到 127.0.0.1:18765（§3.1）。
// owner token 在这里 mint、在这里消费，任何响应体里都不出现。

import http from 'node:http';
import crypto from 'node:crypto';

import { HOST, PORT, TIMEOUT_MS, CREATE_TIMEOUT_MS, AWAITING_HUMAN_SEC } from './lib/config.mjs';
import { novncUrlFor } from './lib/novnc-auth.mjs';
import * as db from './lib/db.mjs';
import * as S from './lib/screens.mjs';
import { BoxError, badRequest, timeout as timeoutErr, actionBlocked } from './lib/errors.mjs';
import { getPage, currentUrl } from './lib/browser.mjs';
import { takeStrippedSnapshot, isSensitiveRef } from './lib/snapshot.mjs';
import { captureDesktopPng } from './lib/screenshot.mjs';
import { runDesktopInput } from './lib/desktop-input.mjs';
import { checkDestination } from './lib/url-guard.mjs';
import { screenPaths } from './lib/workspace.mjs';
import { workspaceLs, workspaceRead, workspaceWrite } from './lib/workspace-io.mjs';
import { withCaller, sanitizeCaller } from './lib/caller.mjs';

const ACTIONS = new Set(['click', 'fill', 'select', 'press', 'scroll']);
// 携带输入的动作。敏感节点闸门按这个集合判（规格 §7.1）——
// 白名单而不是「只挡 fill」，新增动作时忘了加会被 E4 抓住。
const INPUT_ACTIONS = new Set(['fill', 'select', 'press']);

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(timeoutErr(`${what} 超过 ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ---------------------------------------------------------------- 页面动作

/**
 * 取快照并按结果推状态机。
 * 检出敏感节点 → needsHuman + 该屏转 awaiting_human（规格 §6.2 / §5.2），
 * 两件事必须在同一次请求里做完，否则调用方能在翻转之前再抢一次快照。
 */
async function snapshotEnvelope(row, requestId) {
  const page = await getPage(Number(row.display));
  const { snapshot, needsHuman, reason } = await takeStrippedSnapshot(page);
  const body = {
    screen: row.name,
    url: page.url(),
    title: await page.title().catch(() => ''),
    needsHuman,
    reason,
    snapshot, // 剥离后的 YAML 文本，不是 JSON 数组：层级正是「按钮属于哪个表单」的依据
  };
  if (needsHuman) {
    // state + novncUrl 是硬要求（规格 §6）：MCP server 靠这两个字段判断要不要弹浏览器。
    // 自动翻转成接管时若不带，验收 E5 会静默失败 —— 人永远等不到那扇窗。
    await S.toAwaitingHuman(row.name, reason, requestId);
    body.state = 'awaiting_human';
    body.novncUrl = novncUrlFor(Number(row.display));
    body.expiresInSec = AWAITING_HUMAN_SEC;
  } else {
    await S.markIdle(row.name);
    body.state = 'idle';
  }
  return body;
}

// 页面动作的共同外壳：上屏锁 → 复核闸门 → driving_page → 干活 → 出快照。
//
// 为什么进锁之后还要再过一次闸门：两个并发 act 会同时通过入口处的闸门排进队列，
// 前一个的快照可能把屏翻成 awaiting_human —— 后一个若不复核，就正好在人输密码时动手。
// §7.1 说的是「无条件」，那就不能有这个窗口。
async function drive(row, requestId, fn) {
  return S.withLock(row.name, async () => {
    row = await S.gate(row.name, 'page');
    await S.markDriving(row.name);
    try {
      await fn();
      return await snapshotEnvelope(row, requestId);
    } catch (e) {
      // 出错也要把状态放回去，不然这块屏会永远卡在 driving_page
      const cur = await S.getActive(row.name);
      if (cur && cur.state === 'driving_page') await S.markIdle(row.name);
      throw e;
    }
  });
}

async function handleOpen(row, body, requestId) {
  const url = body?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw badRequest('url 必须是 http(s) 绝对地址');
  }
  // 目的地闸门（规格 §7.2）。这里是调用方给的 URL 进入系统的**唯一**入口，
  // 所以闸门只此一处。挡的是「容器自己」—— 调试口 9222+N、窗口服务 18765、
  // noVNC 6080/6081 全在这台机器上，随便哪一个都绕开整套 owner token 机制。
  // 用 ACTION_BLOCKED 而不是 BAD_REQUEST：这是纪律拒绝，不是调用方参数写错。
  const dest = await checkDestination(url);
  if (!dest.ok) {
    S.log(`拒绝 open_url：${dest.reason}（屏 ${row.name}，请求 ${requestId}）`);
    throw actionBlocked(`${dest.reason}。规格 §7.2：调试口、VNC 口、窗口服务不对调用方开放`);
  }
  await S.audit(row.name, 'open_url', requestId);
  return drive(row, requestId, async () => {
    // 九个工具里**只有这里**允许按需拉起浏览器（规格 §6.1）。snapshot / act 探活失败
    // 直接给 BROWSER_GONE，把调用方指回这条路 —— 只读操作不该有副作用（§6.2、坑 11）。
    const page = await getPage(Number(row.display), { autoStart: true });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS - 2000 });
  });
}

async function handleAct(row, body, requestId) {
  const { action, ref, text, key } = body ?? {};
  if (!ACTIONS.has(action)) throw badRequest(`action 必须是 ${[...ACTIONS].join(' / ')}`);
  if (typeof ref !== 'string' || !ref) throw badRequest('ref 必填');
  if (action === 'fill' && typeof text !== 'string') throw badRequest('fill 需要 text');
  if (action === 'select' && typeof text !== 'string') throw badRequest('select 需要 text');
  if (action === 'press' && typeof key !== 'string') throw badRequest('press 需要 key');

  // fill 只记 action，不记 text（规格 §10）
  await S.audit(row.name, action, requestId);

  return drive(row, requestId, async () => {
    const page = await getPage(Number(row.display));
    const loc = page.locator('aria-ref=' + ref);
    const opts = { timeout: TIMEOUT_MS - 5000 };

    // 敏感节点闸门（规格 §7.1）。**必须在 switch 之前、按动作白名单判**，不能塞进
    // 某一个 case 里 —— 以前只有 case 'fill' 有这段，press 是敞开的：逐字符 press
    // 就是一次完整的代填，§8 的「不看、不代填」在那条路上等于不存在。
    //
    // act 前重取节点属性判定，不信任调用方传来的 ref 语义。
    // click / scroll 不挡：它们不携带输入，挡了调用方连聚焦和滚动都做不了。
    if (INPUT_ACTIONS.has(action) && await isSensitiveRef(page, ref)) {
      throw actionBlocked('拒绝向密码 / 一次性验证码 / 卡号字段输入，请走 ask_human');
    }

    switch (action) {
      case 'click':
        await loc.click(opts);
        break;
      case 'fill':
        await loc.fill(text, opts);
        break;
      case 'select':
        await loc.selectOption(text, opts);
        break;
      case 'press':
        await loc.press(key, opts);
        break;
      case 'scroll':
        // 规格没定义滚动语义，这里定为「把该 ref 滚进视口」，因为 act 的入参只有 ref
        await loc.scrollIntoViewIfNeeded(opts);
        break;
    }
  });
}


async function handleDesktop(row, body, requestId) {
  await S.audit(row.name, 'desktop_input', requestId);
  const png = await S.withLock(row.name, async () => {
    await S.gate(row.name, 'page');
    await S.markDriving(row.name);
    try {
      return await runDesktopInput(Number(row.display), body);
    } finally {
      const cur = await S.getActive(row.name);
      if (cur && cur.state === 'driving_page') await S.markIdle(row.name);
    }
  });
  return {
    screen: row.name,
    state: 'idle',
    mime: 'image/png',
    base64: png.toString('base64'),
    bytes: png.length,
  };
}

// ---------------------------------------------------------------- 路由

const routes = [
  {
    method: 'POST', path: /^\/v1\/screens$/, gate: null, timeout: CREATE_TIMEOUT_MS,
    run: (_m, body, rid) => S.createScreen(body?.screen ?? body?.name, rid, { steal: body?.steal === true }),
  },
  {
    method: 'GET', path: /^\/v1\/screens$/, gate: null,
    run: async () => {
      const rows = await S.listActive();
      const screens = await Promise.all(rows.map(async (r) => ({
        screen: r.name,
        display: Number(r.display),
        state: r.state,
        url: await currentUrl(Number(r.display)),
        novncUrl: novncUrlFor(Number(r.display)),
        // 工作区路径也报出来：agent 重连之后（或换了一个 agent 接手）要能直接找回
        // 自己那格目录，而不是靠记住命名规则去拼。这里只算路径不建目录 ——
        // 建目录是 create_screen 的事，list 是只读操作（§6.2 的纪律）。
        workspace: screenPaths(r.name),
      })));
      return { screens };
    },
  },
  // 拆屏、release、list 在 awaiting_human 期间放行（规格 §7.1）
  {
    method: 'DELETE', path: /^\/v1\/screens\/([^/]+)$/, gate: 'always',
    run: (_m, _b, rid, row) => S.destroyScreen(row.name, rid),
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/release$/, gate: 'always',
    run: (_m, _b, rid, row) => S.release(row.name, rid),
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/ask-human$/, gate: 'always',
    run: async (m, body, rid, row) => {
      const reason = ['password', 'otp', 'captcha', 'payment', 'other'].includes(body?.reason)
        ? body.reason : 'other';
      // 已在接管中就当幂等，不重置计时器 —— 否则调用方能靠反复 ask_human 把屏永久占住
      if (row.state !== 'awaiting_human') {
        await S.toAwaitingHuman(row.name, reason, rid);
        S.log(`${row.name} 转 awaiting_human（${reason}）：${String(body?.message ?? '').slice(0, 200)}`);
      }
      return {
        screen: row.name,
        state: 'awaiting_human',
        novncUrl: novncUrlFor(Number(row.display)),
        expiresInSec: AWAITING_HUMAN_SEC,
      };
    },
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/workspace\/ls$/, gate: 'workspace-read',
    run: (_m, body, rid, row) => workspaceLs(row.name, body?.path),
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/workspace\/read$/, gate: 'workspace-read',
    run: (_m, body, rid, row) => workspaceRead(row.name, body?.path),
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/workspace\/write$/, gate: 'workspace-write',
    run: async (_m, body, rid, row) => {
      await S.audit(row.name, 'workspace_write', rid);
      return workspaceWrite(row.name, body?.path, body?.content);
    },
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/desktop-input$/, gate: 'page',
    run: (_m, body, rid, row) => handleDesktop(row, body, rid),
  },
  // 以下四个受 awaiting_human 闸门
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/open$/, gate: 'page',
    run: (_m, body, rid, row) => handleOpen(row, body, rid),
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/snapshot$/, gate: 'page',
    run: async (_m, _b, rid, row) => {
      await S.audit(row.name, 'snapshot', rid);
      return S.withLock(row.name, async () =>
        snapshotEnvelope(await S.gate(row.name, 'page'), rid)); // 进锁复核，理由见 drive()
    },
  },
  {
    method: 'POST', path: /^\/v1\/screens\/([^/]+)\/act$/, gate: 'page',
    run: (_m, body, rid, row) => handleAct(row, body, rid),
  },
  {
    method: 'GET', path: /^\/v1\/screens\/([^/]+)\/screenshot$/, gate: 'page',
    run: async (_m, _b, rid, row) => {
      await S.audit(row.name, 'screenshot', rid);
      // 同样进锁复核：截的是整块桌面，抢在翻转中间拍一张就等于把接管窗口拍下来了
      const png = await S.withLock(row.name, async () => {
        await S.gate(row.name, 'page');
        return captureDesktopPng(Number(row.display));
      });
      // 传 base64 而不是原始字节：MCP server 要包成 image content，信封统一是 JSON
      return {
        screen: row.name,
        state: row.state, // 屏级响应一律带 state（规格 §6）
        mime: 'image/png',
        base64: png.toString('base64'),
        bytes: png.length,
      };
    },
  },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(badRequest('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(badRequest('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  // 闸门可能在读请求体之前就拒了；不排干净剩余字节，客户端会看到连接被重置而不是 JSON 错误
  res.req?.resume?.();
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const rid = req.headers['x-request-id'] || crypto.randomUUID();
  const path = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

  const route = routes.find((r) => r.method === req.method && r.path.test(path));
  if (!route) return send(res, 404, { error: { code: 'WINDOW_GONE', message: '没有这个接口' } });

  const m = route.path.exec(path);
  const name = m[1] ? decodeURIComponent(m[1]) : null;

  // 调用方自报的标识，只落进 audit（规格 §10）。**在这儿起一次上下文**，
  // 而不是当第四个参数往下透传 —— 只有 audit() 用得到它。
  const caller = sanitizeCaller(req.headers['x-mac-bot-client']);

  try {
    return await withCaller(caller, async () => {
      // 闸门先于任何参数校验、也先于读请求体（规格 §7.1）：
      // 一块正在被人接管的屏，连「你的 JSON 写错了」都不该回，直接 WINDOW_BUSY。
      const row = route.gate ? await S.gate(name, route.gate) : null;
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await withTimeout(
        Promise.resolve(route.run(m, body, rid, row)),
        route.timeout ?? TIMEOUT_MS,
        `${req.method} ${path}`
      );
      send(res, 200, out);
    });
  } catch (e) {
    if (e instanceof BoxError) {
      send(res, e.http, { error: { code: e.code, message: e.message } });
    } else {
      S.log('未归类错误：', e?.stack ?? e);
      send(res, 500, { error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
    }
  }
});

await db.init();
await S.recover();
server.listen(PORT, HOST, () => S.log(`窗口服务监听 http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    S.log(`收到 ${sig}，停止监听。不拆屏 —— 屏的生死只由 destroy_screen 决定（规格 §5.1）`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
