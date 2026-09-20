// SQLite 访问层。表结构照《规格-MVP-v1》§10，一列不多一列不少。
//
// 为什么走 sqlite3 命令行而不是 npm 驱动：
//   - 镜像里的 node 是 20.x，没有 node:sqlite（22.5+ 才有）
//   - better-sqlite3 要 node-gyp（python3/make/g++），镜像里一个都没有，
//     为了一张两列表往镜像里塞编译链不划算
//   - 而 sqlite3 CLI 本来就在 Dockerfile 的排查工具里
// 单进程串行写，没有并发锁问题；真要换驱动，只需换掉本文件。
//
// 屏名是调用方给的，注入面必须堵死。这里不用 `.parameter set`：CLI 的点命令按空白与引号
// 分词，值里出现 `''`（转义后的单引号）会被拆成多个参数，直接报用法错误 —— 实测过。
// 所以走 SQL 字面量，单引号加倍是 SQLite 唯一的字符串转义（没有反斜杠转义），足够安全；
// 另外剔掉 NUL，它会让 CLI 提前截断输入。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.mjs';

// SQL 字面量。数字直出，其余按单引号字符串转义。
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

// 把 $name 占位符换成字面量。SQL 由本文件写死，只有值来自外部。
function bind(sql, params) {
  const out = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? literal(params[k]) : m
  );
  return out.trim().endsWith(';') ? out : out + ';';
}

// 脚本从 stdin 喂进去；必须显式 end() 关掉 stdin，否则 sqlite3 会一直等下一条命令。
function runScript(lines) {
  const script = ['.bail on', '.timeout 5000', ...lines].join('\n') + '\n';
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [DB_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`sqlite3 退出 ${code}：${stderr.trim()}`));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

export async function exec(sql, params = {}) {
  await runScript([bind(sql, params)]);
}

export async function all(sql, params = {}) {
  const out = await runScript(['.mode json', bind(sql, params)]);
  const text = out.trim();
  if (!text) return []; // 空结果集时 sqlite3 什么都不打印
  return JSON.parse(text);
}

export async function get(sql, params = {}) {
  const rows = await all(sql, params);
  return rows[0] ?? null;
}

export async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  await runScript([
    `CREATE TABLE IF NOT EXISTS screens (
       name       TEXT PRIMARY KEY,
       display    INTEGER NOT NULL,
       token      TEXT NOT NULL,
       state      TEXT NOT NULL,
       created_at TEXT NOT NULL,
       status     TEXT NOT NULL,
       occupant   TEXT
     );`,
    // 没有 transcripts 表。对话历史归调用方，我们不存、不看、不落盘（规格 §10）。
    `CREATE TABLE IF NOT EXISTS audit (
       screen     TEXT NOT NULL,
       action     TEXT NOT NULL,
       request_id TEXT,
       ts         TEXT NOT NULL,
       client     TEXT
     );`,
    `CREATE INDEX IF NOT EXISTS audit_screen_ts ON audit(screen, ts);`,
  ]);

  // client 列是后加的，而 audit 表活在持久卷里（规格 §10.1）——
  // `CREATE TABLE IF NOT EXISTS` 对已经存在的表一个字都不改，老库升上来就会少这一列，
  // 于是每次审计写入都失败（只是被 audit() 吞掉，静默丢账）。补一次幂等的 ALTER。
  const cols = await all('PRAGMA table_info(audit)');
  if (!cols.some((c) => c.name === 'client')) {
    await runScript(['ALTER TABLE audit ADD COLUMN client TEXT;']);
  }

  // occupant 是 v2.1 占用纪律加的。老库升上来同样要 ALTER，否则写入失败。
  const screenCols = await all('PRAGMA table_info(screens)');
  if (!screenCols.some((c) => c.name === 'occupant')) {
    await runScript(['ALTER TABLE screens ADD COLUMN occupant TEXT;']);
  }
}
