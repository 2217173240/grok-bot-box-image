// 桌面截图。xwd -root + convert，实测路径（《可行性实测》T9）。
// 走桌面级而不是 Playwright 的页面截图：眼睛要能看见浏览器之外的东西（弹窗、下载条、崩溃页）。

import { spawn } from 'node:child_process';
import { internal } from './errors.mjs';

export function captureDesktopPng(display, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    // 管道两端都在容器里，用 shell 串起来最省事；参数只有显示号，且是服务端自己算的整数。
    const child = spawn('bash', [
      '-c',
      `xwd -root -display :${display} -silent | convert xwd:- png:-`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(internal(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length === 0) {
        reject(internal(`截图失败（code=${code}）：${stderr.trim()}`));
        return;
      }
      resolve(buf);
    });
  });
}
