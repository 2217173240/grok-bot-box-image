// 同步器与真实浏览器探针共用同一份页内写入逻辑，避免测试复制实现。
export const writeLs = (origin, entries, allowReload) => `(() => { try {
  if (location.origin !== ${JSON.stringify(origin)}) return { wrote: 0, reloaded: false };
  const want = ${JSON.stringify(entries)};
  const wasEmpty = localStorage.length === 0;
  let n = 0;
  for (const [k, v] of want) { if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n += 1; } }
  const reloaded = n > 0 && wasEmpty && ${allowReload};
  if (reloaded) location.reload();
  return { wrote: n, reloaded };
} catch (e) { return { error: String(e) }; } })()`;
