// 调用方标识，只为审计（规格 §10）。
//
// ## 为什么要有它
//
// 一台容器同时接好几个 agent（§4.6）之后，audit 表原来的四列
// (screen, action, request_id, ts) 记不下**是谁**。destroy_screen / human_release /
// create_screen 这三个动作都能影响别人那块屏，出了事翻审计只看得到「某块屏被拆了」。
//
// request_id 也顶不了这个用：mcp-server 从头到尾没设过 x-request-id，真实路径上它
// 永远是服务端自己 randomUUID 出来的 —— 连「不稳定的自报身份」都不是。
//
// ## 它不是鉴权，别当鉴权用
//
// 值是调用方自报的（MCP 握手时 client 自己声明的 name/version + 它的 pid），
// 想伪造随手就能改。用途只有一个：**区分几个善意的 agent**，好回答「刚才是谁拆的屏」。
// 真要挡蓄意越界得上鉴权层，而「本机任何进程都能连 MCP」已经在 §9.4 知情接受了 ——
// 在这儿摆一个假的身份闸只会给人假的安全感。
//
// ## 为什么走 AsyncLocalStorage 而不是加一个参数
//
// rid 是一路透传下去的第三个参数，已经穿过十来个函数签名。再挂一个只有 audit()
// 用得到的参数，等于让每一层都知道一件与它无关的事。这里在 HTTP 分发那一处
// 起一次上下文，audit() 自己去取。

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** 一次请求期间跑 fn，期间 currentCaller() 返回这个标识。 */
export const withCaller = (label, fn) => store.run(label ?? '', fn);

/** 当前请求的调用方标识；不在请求上下文里（守护、恢复流程）时是空串。 */
export const currentCaller = () => store.getStore() ?? '';

/**
 * 自报标识的清洗。**长度和字符都要限**：它会原样落进 audit 表，
 * 而调用方是任意第三方 —— 换行会把日志搅乱，超长字符串会把表撑大。
 */
export function sanitizeCaller(raw) {
  return String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 占用纪律用的身份。去掉 pid：同一路 client 重启后 pid 会变（E10），
 * 但 name/version 不变。挡的是两路不同的善意 agent 互抢，不是同进程复用。
 */
export function occupantKey(label = currentCaller()) {
  return String(label ?? '').replace(/\s+pid=\d+\s*$/i, '').trim();
}
