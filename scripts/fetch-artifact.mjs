import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...flags] = process.argv.slice(2);
if (!id || flags.some(flag => flag !== '--load')) throw new Error('Usage: node scripts/fetch-artifact.mjs ARTIFACT_ID [--load]');
const manifest = JSON.parse(await readFile(path.join(root, 'artifacts/manifest.json'), 'utf8'));
const artifact = manifest.artifacts.find(item => item.id === id);
if (manifest.schemaVersion !== 1 || !artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || path.basename(artifact.file) !== artifact.file || new URL(artifact.url).protocol !== 'https:') throw new Error('Invalid artifact identity or unknown artifact ID');
if (flags.includes('--load') && artifact.kind !== 'docker-image') throw new Error('--load requires a Docker image artifact');
const directory = path.join(root, '.cache/artifacts');
const target = path.join(directory, artifact.file);
await mkdir(directory, { recursive: true });

async function verify(file) {
  if ((await stat(file)).size !== artifact.bytes) throw new Error(`Artifact size mismatch: ${artifact.file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch: ${artifact.file}`);
}

let present;
try { await stat(target); present = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
if (present) {
  await verify(target);
} else {
  const partial = `${target}.${randomUUID()}.partial`;
  try {
    console.log(`Downloading ${artifact.file}`);
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(1_200_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    await verify(partial);
    await rename(partial, target);
  } finally { await rm(partial, { force: true }); }
}
console.log(`Verified ${target}`);

if (flags.includes('--load')) {
  // 先验证归档，再交给 Docker 导入；不会启动或替换容器。
  execFileSync('docker', ['image', 'load', '--input', target], { stdio: 'inherit' });
  const [image] = JSON.parse(execFileSync('docker', ['image', 'inspect', artifact.reference], { encoding: 'utf8' }));
  if (!image.RepoDigests?.includes(artifact.reference) || `${image.Os}/${image.Architecture}` !== artifact.platform || image.Config.Labels?.['org.opencontainers.image.source'] !== artifact.sourceRepository || image.Config.Labels?.['org.opencontainers.image.revision'] !== artifact.sourceRevision) throw new Error('Loaded image digest, platform, or source labels do not match');
  console.log(`Verified image ${artifact.reference}`);
}
