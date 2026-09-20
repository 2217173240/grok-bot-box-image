// 跑 box-image 下的脚本。窗口的开关一律经 start-window / stop-window / box-chrome，
// 本服务不自己拼 Xvfb / chromium 命令行 —— 端口公式和关屏顺序只有一份实现（规格 §3.2）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { BIN_DIR } from './config.mjs';

/**
 * @returns {Promise<{code:number, stdout:string, stderr:string}>} 不因非零退出码 reject，
 *          因为退出码 75 是有语义的返回值，不是异常（规格 §5.3）。
 */
export function runScript(name, args = [], { env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(BIN_DIR, name), args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
