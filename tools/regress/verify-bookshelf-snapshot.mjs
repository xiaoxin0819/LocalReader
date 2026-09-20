// 验证「书架秒开」：冷启动 → 首次列书架走真实扫描；杀掉进程再起 → 首次列书架
// 必须命中磁盘快照（快且 stale=true），随后后台重扫给出真实数量。
// 用独立端口，不碰正式服务；只读写项目自己的 .cache。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PROBE_PORT || 7799);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

async function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b.toString()));
  child.stderr.on("data", (b) => (log += b.toString()));
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    try { await fetch(BASE + "/api/state"); return { child, bootMs: Date.now() - t0, log: () => log }; }
    catch { await sleep(25); }
  }
  throw new Error("服务没起来: " + log);
}

async function books() {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/books?shelf=0");
  const j = await r.json();
  return { ms: Date.now() - t0, count: (j.books || []).length, stale: !!j.stale, root: j.root };
}

let s1, s2;
try {
  /* --- 1. 冷启动：有快照就秒回 stale=true，同时后台真实重扫 --- */
  s1 = await startServer();
  console.log(`\n[第 1 次启动] 端口就绪 ${s1.bootMs} ms`);
  const a = await books();
  console.log(`  首次列书架: ${a.ms} ms  ${a.count} 本  stale=${a.stale}`);
  check("冷启动首次快速返回（<=120ms）", a.ms <= 120, `${a.ms} ms`);
  check("真实扫描数量合理（>0）", a.count > 0, `${a.count} 本`);
  const truth = a.count;

  // 等快照落盘（saveBookSnapshotSoon 有 400ms 防抖）
  await sleep(1200);

  /* --- 2. 杀掉再起：必须秒回快照 --- */
  s1.child.kill("SIGKILL");
  s1 = null;
  await sleep(600);

  s2 = await startServer();
  console.log(`\n[第 2 次启动] 端口就绪 ${s2.bootMs} ms`);
  const b = await books();
  console.log(`  首次列书架: ${b.ms} ms  ${b.count} 本  stale=${b.stale}`);
  check("重启后首次返回快照（stale=true）", b.stale === true, `stale=${b.stale}`);
  check("快照数量与真实一致", b.count === truth, `快照=${b.count} 真实=${truth}`);
  check("重启后首次列书架足够快（<=120ms）", b.ms <= 120, `${b.ms} ms`);

  /* --- 3. 后台重扫完成后返回真实结果 --- */
  let c = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    c = await books();
    if (!c.stale) break;
  }
  console.log(`  后台重扫完成: ${c.ms} ms  ${c.count} 本  stale=${c.stale}`);
  check("后台重扫后不再 stale", c.stale === false, `stale=${c.stale}`);
  check("重扫结果与首次扫描一致", c.count === truth, `${c.count} vs ${truth}`);

  /* --- 4. 短 TTL 内重复请求应命中内存缓存 --- */
  const d = await books();
  check("内存缓存命中（stale=false 且很快）", d.stale === false && d.ms <= 60, `${d.ms} ms stale=${d.stale}`);

  /* --- 5. 快照文件确实写在项目 .cache 下 --- */
  const snapDir = path.join(ROOT, ".cache", "booklist");
  const files = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((f) => f.endsWith(".json")) : [];
  check("快照落在项目 .cache/booklist 下", files.length > 0, `${files.length} 个文件`);
  if (files.length) {
    const raw = JSON.parse(fs.readFileSync(path.join(snapDir, files[0]), "utf8"));
    check("快照结构完整（root/at/books）", !!raw.root && !!raw.at && Array.isArray(raw.books),
      `root=${raw.root} books=${raw.books?.length}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${failed.length === 0 ? "全部通过" : "有失败"} (${results.length - failed.length}/${results.length}) ===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  for (const s of [s1, s2]) { try { s?.child.kill("SIGKILL"); } catch {} }
  await sleep(400);
}
