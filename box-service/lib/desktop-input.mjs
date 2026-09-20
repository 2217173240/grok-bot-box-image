import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { badRequest, internal } from './errors.mjs';
import { captureDesktopPng } from './screenshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'xtest-input.py');
const ACTIONS = new Set(['click', 'type', 'key', 'scroll']);

export function assertPoint(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw badRequest('坐标必须是整数');
  }
  if (x < 0 || y < 0 || x > 1279 || y > 799) {
    throw badRequest(`坐标越界：(${x},${y})，合法范围 0..1279 × 0..799`);
  }
}

function runHelper(display, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [HELPER, `:${display}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(internal(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) reject(badRequest(stderr.trim() || '桌面输入参数不合法'));
      else if (code !== 0) reject(internal(`桌面输入失败（code=${code}）：${stderr.trim()}`));
      else resolve();
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runDesktopInput(display, body = {}) {
  const action = body.action;
  if (!ACTIONS.has(action)) {
    throw badRequest(`action 必须是 ${[...ACTIONS].join(' / ')}`);
  }
  const payload = { action };
  if (action === 'click' || action === 'scroll') {
    assertPoint(body.x, body.y);
    payload.x = body.x;
    payload.y = body.y;
    if (action === 'scroll') {
      payload.dir = (body.text === 'up' || body.key === 'up') ? 'up' : 'down';
    }
  } else if (action === 'type') {
    if (typeof body.text !== 'string' || body.text.length === 0) {
      throw badRequest('type 需要 text');
    }
    if (body.x != null || body.y != null) assertPoint(body.x, body.y);
    if (Number.isInteger(body.x) && Number.isInteger(body.y)) {
      payload.x = body.x;
      payload.y = body.y;
    }
    payload.text = body.text;
  } else if (action === 'key') {
    if (typeof body.key !== 'string' || !body.key) {
      throw badRequest('key 需要 key');
    }
    if (body.x != null || body.y != null) assertPoint(body.x, body.y);
    if (Number.isInteger(body.x) && Number.isInteger(body.y)) {
      payload.x = body.x;
      payload.y = body.y;
    }
    payload.key = body.key;
  }
  await runHelper(display, payload);
  await new Promise((r) => setTimeout(r, 400));
  return captureDesktopPng(display);
}
