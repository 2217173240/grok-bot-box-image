// open_url 的目的地闸门（规格 §7.2：调试口、VNC 原始口、cookie 库、token 明文
// 「没有任何一个工具能返回或触达它们」）。
//
// 洞口是这样开的：页面驱动和 Chromium 都跑在容器里，于是调用方一句
// `open_url http://127.0.0.1:9224/json/list` 就把另一块屏的 CDP 调试口读进快照 ——
// 那个口能读全机 cookie，整套 owner token 机制在它面前不存在。18765（窗口服务）、
// 1339（窗口路由器）、6080/6081（noVNC）同理。
//
// ## 判据：容器自身地址 × 系统自己的端口
//
// **地址那一维不能只看字面量 `127.0.0.1`。** 实测容器内监听清单里，18765 / 6080 / 6081
// 绑的都是 `0.0.0.0`，也就是说容器自己的 eth0 地址（实测这台是 192.168.215.2）一样打得通。
// 所以挡的是「这个地址是不是这台容器自己」：
//
//   - 回环整段 `127.0.0.0/8`（127.0.0.2:18765 一样通）、`::1`
//   - `0.0.0.0/8`：0.0.0.0 连出去在 Linux 上就是连本机
//   - 本机每一张网卡的地址 —— **运行时取，不写死**：容器 IP 每次 `docker run` 都可能变
//
// **端口那一维是有意收窄的，不是「凡是本机一律不给开」。** 容器现在还兼作 agent 的
// Linux 试验场（规格 §4.5）：人在里面 `npm run dev` 起个 3000，然后让 agent 去看一眼，
// 是这套东西该支持的用法。一刀切会把刚加的能力废掉一半。所以只挡系统自己占的那些口，
// 清单从 config.mjs 取 —— 那份本来就是 box-common.sh 的镜像，两边不各自演化。
//
// 清单会不会过期？会 —— 加个新服务忘了登记，洞就重新开了。所以门禁 G11 里有一条
// **反向断言**：把容器里所有在听的端口枚举出来，逐个要求闸门挡得住。
// 新服务一上来那条就红，这是本仓库「断言打效果」那条纪律在这儿的落法。
//
// ## 不挡什么（知情，登记在规格 §9.4）
//
//   - `host.docker.internal` 和局域网：那是「打到 Mac、打到内网」的通用 SSRF 面，
//     不是 §7.2 点名的东西；而 `MAC_BOT_PROXY` 恰恰指向 host.docker.internal（§4.2）。
//   - 重定向：`page.goto` 会跟随 3xx，闸门只看调用方给的那个 URL。
//   - DNS rebinding：这里解析一次、Chromium 再解析一次，中间那一跳换答案就绕过去了。

import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import dns from 'node:dns/promises';

import {
  PORT,
  CDP_BASE,
  VNC_BASE,
  MAX_DISPLAY,
  NOVNC_PRIMARY,
  NOVNC_FORKS,
  ROUTER_PORT,
  EXEC_FORK_BASE,
} from './config.mjs';

// DNS 解析的上限。只有目的地端口命中系统口时才会走到这一步，正常浏览不受影响。
const LOOKUP_TIMEOUT_MS = 3000;

/** 单点系统端口。范围型的（9222+N、5900+N、14000+N）在 isSystemPort 里按段判。 */
const FIXED_PORTS = new Set([PORT, ROUTER_PORT, NOVNC_PRIMARY, NOVNC_FORKS]);

/**
 * 这个端口是不是系统自己占的。
 *
 * 按段判而不是按「当前开了几块屏」判：屏是动态的，闸门不该跟着屏的生死变宽变窄 ——
 * 那样一来「先拆屏再打」就是一条绕过路径。段的上界用 MAX_DISPLAY。
 */
export function isSystemPort(port) {
  if (FIXED_PORTS.has(port)) return true;
  for (const base of [CDP_BASE, VNC_BASE, EXEC_FORK_BASE]) {
    if (port >= base && port <= base + MAX_DISPLAY) return true;
  }
  return false;
}

/** 门禁 G11 要拿这份清单做反向断言，导出给它用。 */
export function systemPorts() {
  const out = new Set(FIXED_PORTS);
  for (const base of [CDP_BASE, VNC_BASE, EXEC_FORK_BASE]) {
    for (let n = 0; n <= MAX_DISPLAY; n += 1) out.add(base + n);
  }
  return [...out].sort((a, b) => a - b);
}

let cached = null;

/**
 * 「这台容器自己」的地址集合。
 *
 * 懒建 + 缓存：网卡要等服务起来才取得到，也不该每个请求扫一遍 `networkInterfaces()`。
 * 容器 IP 在容器生命周期内不变（变了服务也跟着重启了），缓存是安全的。
 */
function selfBlockList() {
  if (cached) return cached;
  const bl = new BlockList();
  bl.addSubnet('127.0.0.0', 8, 'ipv4');
  bl.addSubnet('0.0.0.0', 8, 'ipv4');
  bl.addAddress('::1', 'ipv6');
  bl.addAddress('::', 'ipv6');
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      // 单张网卡地址不合法（链路本地带 scope 之类）不该让整个闸门崩掉：
      // 少收一条地址是降级，抛异常是把 open_url 整个打死。
      try {
        bl.addAddress(ni.address, ni.family === 'IPv6' || ni.family === 6 ? 'ipv6' : 'ipv4');
      } catch { /* 跳过这一张 */ }
    }
  }
  cached = bl;
  return bl;
}

/** BlockList.check 不传 family 时对 IPv4-mapped 的 IPv6 一律返回 false（实测），必须显式传。 */
function hits(bl, addr, family) {
  try {
    return bl.check(addr, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('lookup timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * 判断一个 open_url 目的地能不能去。
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkDestination(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'url 解析不了' };
  }

  // 端口先判：不是系统口就直接放行，正常浏览（80/443）连 DNS 都不用多查一次。
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!isSystemPort(port)) return { ok: true };

  // 数字形式的花样不用自己拆：WHATWG 的 URL 解析器已经归一了。
  // 实测 `2130706433` / `0x7f000001` / `127.1` / `127.000.000.001` 出来全是 `127.0.0.1`，
  // `[::ffff:127.0.0.1]` 出来是 `[::ffff:7f00:1]`（BlockList 认得，见 hits()）。
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // FQDN 的尾点要去掉：`localhost.` 和 `localhost` 是同一台机器，而 URL 会原样留着那个点。
  const name = host.replace(/\.$/, '').toLowerCase();
  const deny = (extra = '') => ({
    ok: false,
    reason: `拒绝打开容器自身的系统端口 ${port}（${u.hostname}${extra}）`,
  });

  if (name === 'localhost' || name.endsWith('.localhost')) return deny();

  const bl = selfBlockList();
  const family = isIP(host);
  if (family) return hits(bl, host, family) ? deny() : { ok: true };

  // 名字：自己解析一次。不解析的话 `localtest.me`、`127.0.0.1.nip.io` 这类
  // 「解析到回环的公网域名」一步就绕过去了。
  //
  // **解析不出来放行**：Chromium 接着自己也会解析不出来然后报错，
  // 在这里因为 DNS 抖一下就把正常网页挡掉，代价比放行大。
  let addrs;
  try {
    addrs = await withTimeout(dns.lookup(name, { all: true }), LOOKUP_TIMEOUT_MS);
  } catch {
    return { ok: true };
  }
  const hit = addrs.find((a) => hits(bl, a.address, a.family));
  return hit ? deny(` 解析到 ${hit.address}`) : { ok: true };
}
