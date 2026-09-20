// 工作区文件三件套（规格 v2.2）。只碰该屏那一格，路径穿越沿用 §4.6 / E19。
import fs from 'node:fs/promises';
import path from 'node:path';

import { badRequest } from './errors.mjs';
import { screenDir } from './workspace.mjs';

const MAX_BYTES = 1_000_000;

function assertRelPath(rel) {
  if (rel == null || rel === '') return '.';
  if (typeof rel !== 'string') throw badRequest('path 必须是字符串');
  if (path.isAbsolute(rel)) throw badRequest('不接受绝对路径');
  if (rel.includes('\0') || /[\x00-\x1f\x7f]/.test(rel)) throw badRequest('path 不能含控制字符');
  return rel;
}

export function resolveInScreen(screen, rel) {
  const root = path.resolve(screenDir(screen));
  const dest = path.resolve(root, assertRelPath(rel));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (dest !== root && !dest.startsWith(prefix)) {
    throw badRequest('路径逃出了该屏工作区');
  }
  return { root, dest };
}

export async function workspaceLs(screen, rel) {
  const { dest } = resolveInScreen(screen, rel);
  let st;
  try { st = await fs.stat(dest); } catch {
    throw badRequest('路径不存在');
  }
  if (!st.isDirectory()) throw badRequest('ls 的目标必须是目录');
  const names = await fs.readdir(dest);
  const entries = [];
  for (const name of names) {
    const s = await fs.stat(path.join(dest, name)).catch(() => null);
    entries.push({
      name,
      type: s?.isDirectory() ? 'dir' : 'file',
      bytes: s && !s.isDirectory() ? s.size : undefined,
    });
  }
  return { screen, path: rel == null || rel === '' ? '.' : rel, entries };
}

export async function workspaceRead(screen, rel) {
  const { dest } = resolveInScreen(screen, rel);
  let st;
  try { st = await fs.stat(dest); } catch {
    throw badRequest('文件不存在');
  }
  if (!st.isFile()) throw badRequest('read 的目标必须是文件');
  if (st.size > MAX_BYTES) throw badRequest(`超过 ${MAX_BYTES} 字节，拒绝读取`);
  const buf = await fs.readFile(dest);
  return {
    screen,
    path: rel,
    bytes: buf.length,
    encoding: 'utf8',
    content: buf.toString('utf8'),
  };
}

export async function workspaceWrite(screen, rel, content) {
  if (typeof content !== 'string') throw badRequest('content 必须是字符串');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) throw badRequest(`超过 ${MAX_BYTES} 字节，拒绝写入`);
  const { root, dest } = resolveInScreen(screen, rel);
  if (dest === root) throw badRequest('不能把工作区根写成文件');
  const parent = path.dirname(dest);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (parent !== root && !parent.startsWith(prefix)) throw badRequest('路径逃出了该屏工作区');
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
  return { screen, path: rel, bytes, ok: true };
}
