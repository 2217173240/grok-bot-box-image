// noVNC 真鉴权。TokenFile 的 token 不再是显示号。
//
// 签发和作废都在窗口服务（唯一权威）。start-desktop 只起桌面，不写这张表 ——
// 否则 token=显示号，本机任何进程都能看任何一块屏（规格 §9.4 那笔债）。
//
// 文件名仍是显示号，好让 stop-window 按 N 清掉。文件内容才是凭证：
//   <32 字节 hex>: localhost:<5900+N>

import crypto from 'node:crypto';
import fs from 'node:fs';
import { PRIMARY_DISPLAY, VNC_BASE, NOVNC_FORKS } from './config.mjs';

export const NOVNC_TOKEN_DIR = '/tmp/sand-novnc-tokens.d';

function vncPort(display) {
  const n = Number(display);
  return n === PRIMARY_DISPLAY ? 5900 : VNC_BASE + n;
}

function tokenPath(display) {
  return `${NOVNC_TOKEN_DIR}/${Number(display)}`;
}

export function mintViewToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 签发一张新凭证，旧的立刻作废。返回 token。 */
export function issue(display) {
  const token = mintViewToken();
  fs.mkdirSync(NOVNC_TOKEN_DIR, { recursive: true });
  const n = Number(display);
  fs.writeFileSync(tokenPath(n), `${token}: localhost:${vncPort(n)}\n`, { mode: 0o600 });
  return token;
}

export function current(display) {
  try {
    const raw = fs.readFileSync(tokenPath(display), 'utf8').trim();
    const token = raw.split(':')[0];
    return token || null;
  } catch {
    return null;
  }
}

export function revoke(display) {
  try { fs.unlinkSync(tokenPath(display)); } catch { /* 没有就不删 */ }
}

/** 有凭证就用，没有就签发。URL 形状仍走 path=websockify?token=…（坑 6）。 */
export function novncUrlFor(display) {
  const token = current(display) ?? issue(display);
  return `http://127.0.0.1:${NOVNC_FORKS}/vnc.html?autoconnect=1&path=${encodeURIComponent(`websockify?token=${token}`)}`;
}
