// 页面驱动。playwright-core 的 connectOverCDP 连该屏已开的那只 Chromium。
//
// 为什么驱动在容器里：调试口 9222+N 只绑容器内回环且不 publish，Playwright 必须和
// Chromium 同侧（规格 §3）。Mac 侧只搬 JSON。

import { chromium } from 'playwright-core';
import { cdpPort } from './config.mjs';
import { runScript } from './run.mjs';
import { internal, snapshotEmpty, browserGone } from './errors.mjs';

const conns = new Map(); // display -> browser

export async function cdpAlive(display) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort(display)}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 当前页面 URL，只读，不建 CDP 会话 —— list_screens 每次都要用，别为它连 Playwright。 */
export async function currentUrl(display) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort(display)}/json/list`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const targets = await res.json();
    const pages = targets.filter((t) => t.type === 'page');
    const real = pages.filter((t) => t.url && t.url !== 'about:blank');
    return (real.at(-1) ?? pages.at(-1))?.url ?? null;
  } catch {
    return null;
  }
}

/** Chromium 不随桌面自动开（门禁 G1 的语义），按需拉起。 */
export async function ensureChromium(display) {
  if (await cdpAlive(display)) return;
  const r = await runScript('box-chrome', [], { env: { DISPLAY: `:${display}` } });
  if (r.code !== 0 || !(await cdpAlive(display))) {
    throw internal(`:${display} 浏览器起不来（code=${r.code}）`);
  }
}

async function connect(display) {
  const cached = conns.get(display);
  if (cached && cached.isConnected()) return cached;
  conns.delete(display);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort(display)}`);
  browser.on('disconnected', () => {
    if (conns.get(display) === browser) conns.delete(display);
  });
  conns.set(display, browser);
  return browser;
}

/**
 * 取该屏要操作的页面。
 * 规格没有定义「多标签页时操作哪个」。这里定为：第一个 context 里最后一个非 about:blank 的页，
 * 都是空白则取最后一页。理由是 box-chrome 用 --new-window about:blank 起的，
 * 调用方 open_url 之后真正在用的总是最新那张。
 *
 * **`autoStart` 默认关，只有 `open_url` 该开**（规格 §6.2 / §6.5）。
 *
 * 这里曾经无条件 `ensureChromium()`，于是 `snapshot` 这个「看」的操作带着隐藏副作用：
 * 浏览器死掉时它会花几秒重启一只，然后 —— 因为新起的浏览器落在 about:blank ——
 * 照样返回 `SNAPSHOT_EMPTY`。白花时间，还把调用方引向「转 ask_human 或放弃」，
 * 而正确动作是 `open_url`（实测 0.4 秒自愈）。见《可行性实测》坑 11。
 */
export async function getPage(display, { autoStart = false } = {}) {
  if (autoStart) {
    await ensureChromium(display);
  } else if (!(await cdpAlive(display))) {
    throw browserGone(`:${display} 的浏览器没在跑，请用 open_url 重开`);
  }
  const browser = await connect(display);
  const ctx = browser.contexts()[0];
  if (!ctx) throw snapshotEmpty(`:${display} 没有浏览器上下文`);
  let pages = ctx.pages();
  if (pages.length === 0) pages = [await ctx.newPage()];
  const real = pages.filter((p) => p.url() && p.url() !== 'about:blank');
  return real.at(-1) ?? pages.at(-1);
}

/** 拆屏时把连接一起丢掉，否则 Playwright 会对着死端口重连。 */
export async function dropConnection(display) {
  const b = conns.get(display);
  conns.delete(display);
  try { await b?.close(); } catch { /* 屏可能已经没了 */ }
}
