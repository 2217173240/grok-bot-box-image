// 每屏一格工作区（规格 §4.6）。多个 agent 共用一台容器时，这是它们之间的隔离边界。
//
// ## 为什么是「每屏一格」而不是「每个 client 一格」
//
// 屏名本来就是这套东西里的持久身份：登录态挂在它上面，reattach 也认它（E10）。
// 文件跟着屏走，于是「一块屏 = 一个浏览器 + 一份登录态 + 一个目录」是同一个故事。
// 另发一个 session id 会和 stdio 的 reattach 模型打架 —— 进程一重启 id 就没了，
// 而屏名不会。
//
// ## 这解决的是「互相踩」，不是「互相防」
//
// 屏名是个无鉴权的全局命名空间：任何 client 用同一个名字 create_screen 就接管同一块屏
// （E10 的 reattach 正是靠这个）。所以这里挡的是**两个 agent 各干各的却写到同一个目录**，
// 不是「A 蓄意去读 B 的文件」—— 后者要真挡得上鉴权层，而「本机任何进程都能连 MCP」
// 这条已经在规格 §9.4 里知情接受了，加一层半吊子的锁只会给人假的安全感。
//
// ## 屏名要当路径用，就得先当不信任的输入检一遍
//
// 屏名是调用方给的任意 1..64 字符串，现在它要变成目录名、还要变成 `mac-bot shell` 的
// cwd 参数。`../` 一进来就能写到工作区外面（比如 `/home/box/chrome-profile`，那是全机
// 登录态）。校验放在窗口服务这个唯一权威里，不放 CLI —— CLI 只是众多入口之一。

import fs from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_ROOT, WORKSPACE_HOST_ROOT } from './config.mjs';
import { badRequest } from './errors.mjs';

/**
 * 屏名能不能当目录名。
 *
 * **只挡路径语义和控制字符，不挡非 ASCII** —— 屏名是给人取的，中文名是常态
 * （验收用例里那块屏就叫「验收屏」）。挡宽了会把正常用法一起废掉。
 */
export function assertUsableAsPath(name) {
  if (name.includes('/') || name.includes('\\')) {
    throw badRequest('屏名不能含 / 或 \\ —— 它要当目录名用');
  }
  if (name.includes('..')) {
    throw badRequest('屏名不能含 ..  —— 那能写到工作区外面去');
  }
  if (name.startsWith('.')) {
    throw badRequest('屏名不能以 . 开头（隐藏目录，且 . 和 .. 本身有路径含义）');
  }
  // 控制字符会把日志、shell 参数、目录列表一起搅乱，而且没有任何正当用途
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw badRequest('屏名不能含控制字符');
  }
  if (name.trim() !== name) {
    throw badRequest('屏名首尾不能有空白 —— 目录名带空白极难排查');
  }
  return name;
}

/** 该屏在容器里的工作区路径。调用前请先过 assertUsableAsPath。 */
export function screenDir(name) {
  return path.join(WORKSPACE_ROOT, name);
}

/** 只算路径、不碰磁盘。给 list_screens 这类只读操作用（§6.2：只读不能有副作用）。 */
export function screenPaths(name) {
  return {
    container: screenDir(name),
    host: WORKSPACE_HOST_ROOT ? path.join(WORKSPACE_HOST_ROOT, name) : null,
  };
}

/**
 * 建出该屏的目录并把两侧路径都算出来。
 *
 * 幂等：reattach 同一个屏名会回到同一个目录，和登录态的持久语义一致。
 * **建不出来不算 create 失败** —— 工作区是便利设施，浏览器才是这块屏的本体；
 * 为了一个目录把整块屏拆掉不划算。建不出来就在返回值里如实说没有。
 */
export async function ensureScreenDir(name) {
  const container = screenDir(name);
  let ok = true;
  try {
    await fs.mkdir(container, { recursive: true });
  } catch {
    ok = false;
  }
  return {
    container: ok ? container : null,
    // Mac 侧路径由 `mac-bot up` 烧进容器（容器自己无从知道宿主机挂的是哪儿）。
    // 老容器没有这个变量，就如实给 null，别猜一个出来骗调用方。
    host: ok && WORKSPACE_HOST_ROOT ? path.join(WORKSPACE_HOST_ROOT, name) : null,
  };
}
