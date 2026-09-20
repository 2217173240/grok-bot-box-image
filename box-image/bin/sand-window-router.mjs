#!/usr/bin/env node
// 窗口路由器。契约见《确定-计算环境-契约》§3.3。
//
//   x-sand-display: <N>        缺省或非法 → 1
//   x-sand-window-owner: <token>
//
//   :1 不验 token（共享主屏）
//   N≥2 必须和 TOKEN_DIR/N 里的字节完全一致；空文件或没有文件 → 拒绝（fail-closed）
//   比较用恒定时间
//   透传，不解析业务帧
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ROUTER_PORT = 1339;
const EXEC_PRIMARY = 1337;
const EXEC_FORK_BASE = 14000;
const TOKEN_DIR = '/tmp/sand-window-tokens.d';
const PRIMARY_DISPLAY = 1;

function parseDisplay(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  // 缺省或非法一律当 :1，不报错——观察值就是这个行为
  return Number.isInteger(n) && n >= 1 ? n : PRIMARY_DISPLAY;
}

function tokenOk(display, presented) {
  let expected;
  try {
    expected = fs.readFileSync(`${TOKEN_DIR}/${display}`);
  } catch {
    return false;              // 没有文件 = 未绑定 = 拒绝
  }
  if (expected.length === 0) return false;   // 空文件也拒绝
  const got = Buffer.from(presented ?? '', 'utf8');
  // 长度不等时 timingSafeEqual 会抛，先用等长缓冲垫平，避免长度成为旁路
  if (got.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(got, expected);
}

const server = http.createServer((req, res) => {
  const display = parseDisplay(req.headers['x-sand-display']);

  if (display !== PRIMARY_DISPLAY &&
      !tokenOk(display, req.headers['x-sand-window-owner'])) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { code: 'WINDOW_FORBIDDEN', message: 'owner token mismatch' },
    }));
    return;
  }

  const target = display === PRIMARY_DISPLAY
    ? EXEC_PRIMARY
    : EXEC_FORK_BASE + display;

  // 透传：不读 body、不解析业务帧，一元和流式都直接管道过去
  const up = http.request(
    { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { code: 'WINDOW_GONE', message: `no backend on :${target}` },
    }));
  });
  req.pipe(up);
});

server.listen(ROUTER_PORT, () => {
  console.error(`[router] 听 ${ROUTER_PORT}，主执行 ${EXEC_PRIMARY}，副屏基数 ${EXEC_FORK_BASE}`);
});
