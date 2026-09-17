/* build-exe.mjs —— 把 LocalReader 打包成单文件 Windows exe
   原理：Node.js SEA（Single Executable Application）
   1) 把 parse-core.mjs + server.mjs 内联成 CJS，前端资源作为 SEA assets 嵌入
   2) node --experimental-sea-config 生成 blob
   3) 复制 node.exe，用 postject 把 blob 注入，再用 rcedit 换图标/版本信息

   用法：node build/build-exe.mjs [--skip-icon]
*/

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");        // 阅读器/
const TMP = path.join(__dirname, ".tmp");
const DIST = path.join(ROOT, "dist");
const APP_NAME = "LocalReader";
const VERSION = "1.0.0";

const SKIP_ICON = process.argv.includes("--skip-icon");

/* 打包所需的外部工具（首次运行会自动下载并缓存到 build/.tmp） */
const POSTJECT_URL = "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz";
const RCEDIT_URL = "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe";

/* ---------------- 工具 ---------------- */

function fail(msg) { console.error("\n[打包失败] " + msg); process.exit(1); }
function step(msg) { console.log("\u2022 " + msg); }

/** 读文本并统一成 LF，避免 CRLF 干扰替换匹配 */
function readLF(p) { return fs.readFileSync(p, "utf8").split("\r\n").join("\n"); }

/** 必须精确替换一次，否则报错（防止源码改动后打包静默失效） */
function replaceOnce(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) fail(`替换 "${label}" 命中 ${n} 次（期望 1 次）。源码可能已改动，请同步更新 build-exe.mjs`);
  return src.split(from).join(to);
}

function findNode() {
  const list = [
    process.env.LOCALREADER_NODE,
    path.join(process.env.USERPROFILE || "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"),
    path.join(process.env.USERPROFILE || "", ".workbuddy/binaries/node/versions/22.22.2-2/node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "OpenAI/Codex/runtimes/cua_node/a708e72b10c27b59/bin/node.exe"),
    process.execPath
  ].filter(Boolean);
  for (const p of list) { if (fs.existsSync(p)) return p; }
  fail("找不到 node.exe，请设置环境变量 LOCALREADER_NODE 指向 node.exe");
}

/* ---------------- 1. 生成内联 bundle ---------------- */

const NODE = findNode();
console.log("Node: " + NODE + " (" + spawnSync(NODE, ["--version"], { encoding: "utf8" }).stdout.trim() + ")");

// 前端资源：全部嵌进 exe
const ASSETS = [["index.html", "public/index.html"], ["style.css", "public/style.css"], ["app.js", "public/app.js"], ["reader.ico", "reader.ico"]];
for (const [, rel] of ASSETS) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail("缺少资源文件: " + rel);
}

// 1a. parse-core.mjs：去掉 export 前缀，变成普通声明
let core = readLF(path.join(ROOT, "parse-core.mjs"));
const coreExports = (core.match(/^export /gm) || []).length;
if (!coreExports) fail("parse-core.mjs 里没找到 export，解析异常");
core = core.replace(/^export /gm, "");

// 1b. server.mjs：拆掉对 parse-core 的相对导入（已内联）
let srv = readLF(path.join(ROOT, "server.mjs"));

srv = replaceOnce(srv, [
  'import http from "node:http";',
  'import fs from "node:fs";',
  'import fsp from "node:fs/promises";',
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'import { decodeBuffer, analyzeText } from "./parse-core.mjs";'
].join("\n") + "\n", "", "server.mjs 的 import 块");

// 1c. 路径：exe 模式下资源在内存里，配置与字体写到用户数据目录
srv = replaceOnce(srv,
  "const __dirname = path.dirname(fileURLToPath(import.meta.url));\n" +
  'const PUBLIC_DIR = path.join(__dirname, "public");\n' +
  'const CONFIG_PATH = path.join(__dirname, "reader.config.json");',
  [
    "/* exe 模式：配置与字体放用户数据目录，避免污染 exe 所在目录（如桌面） */",
    "const APP_DIR = process.env.LOCALREADER_DATA",
    "  || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), \"LocalReader\");",
    "try { fs.mkdirSync(APP_DIR, { recursive: true }); } catch {}",
    "const PUBLIC_DIR = \"__sea_assets__\";",
    'const CONFIG_PATH = path.join(APP_DIR, "reader.config.json");',
  ].join("\n"), "PUBLIC_DIR / CONFIG_PATH 头块");

srv = replaceOnce(srv,
  'const FONT_DIR = path.join(__dirname, "fonts");\n'.replace("\\n", "\n") +
  'try { fs.mkdirSync(FONT_DIR, { recursive: true }); } catch {}',
  'const FONT_DIR = path.join(APP_DIR, "fonts");\n' +
  'try { fs.mkdirSync(FONT_DIR, { recursive: true }); } catch {}', "FONT_DIR");

// 1d. 静态资源改为从内联资源读取
srv = replaceOnce(srv,
  [
    "async function serveStatic(res, urlPath) {",
    '  let rel = decodeURIComponent(urlPath);',
    '  if (rel === "/" || rel === "") rel = "/index.html";',
    "  const abs = path.join(PUBLIC_DIR, rel);",
    '  if (!abs.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "禁止" });',
    "  try {",
    "    const buf = await fsp.readFile(abs);",
    '    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || "application/octet-stream");',
    "  } catch {",
    '    send(res, 404, { error: "未找到" }, "application/json; charset=utf-8");',
    "  }",
    "}",
  ].join("\n"),
  [
    "async function serveStatic(res, urlPath) {",
    "  let rel = decodeURIComponent(urlPath);",
    '  if (rel === "/" || rel === "") rel = "/index.html";',
    '  rel = rel.replace(/^\\/+/, "").replace(/\\\\/g, "/");',
    '  if (rel.includes("..")) return send(res, 403, { error: "禁止" });',
    "  const asset = SEA_ASSETS[rel];",
    '  if (!asset) return send(res, 404, { error: "未找到" }, "application/json; charset=utf-8");',
    "  try {",
    '    const buf = Buffer.from(sea.getAsset(asset));',
    '    send(res, 200, buf, MIME[path.extname(rel).toLowerCase()] || "application/octet-stream");',
    "  } catch {",
    '    send(res, 404, { error: "未找到" }, "application/json; charset=utf-8");',
    "  }",
    "}",
  ].join("\n"), "serveStatic");

// 1e. 启动逻辑：已在运行就直接开页面；关掉控制台窗口即停服
srv = replaceOnce(srv,
  [
    'server.listen(PORT, "127.0.0.1", () => {',
    "  console.log(`阅读器已启动: http://127.0.0.1:${PORT}`);",
    "});",
  ].join("\n"),
  [
    "function openBrowser() {",
    "  const url = `http://127.0.0.1:${PORT}/`;",
    "  try {",
    '    if (process.env.LOCALREADER_NO_BROWSER) return;',
    '    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();',
    "  } catch (e) { console.log(\"请手动打开: \" + url); }",
    "}",
    "",
    "function probeRunning() {",
    "  return new Promise((resolve) => {",
    '    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/state", timeout: 800 }, (r) => {',
    "      r.resume();",
    "      resolve(r.statusCode === 200);",
    "    });",
    '    req.on("error", () => resolve(false));',
    '    req.on("timeout", () => { req.destroy(); resolve(false); });',
    "  });",
    "}",
    "",
    "(async () => {",
    "  if (await probeRunning()) {",
    "    console.log(`阅读器已在运行: http://127.0.0.1:${PORT}`);",
    "    openBrowser();",
    "    return;",
    "  }",
    '  server.on("error", (e) => {',
    '    if (e.code === "EADDRINUSE") {',
    "      console.log(`端口 ${PORT} 被占用，直接打开页面…`);",
    "      openBrowser();",
    "      setTimeout(() => process.exit(0), 1200);",
    "    } else {",
    '      console.error("启动失败: " + e.message);',
    "      process.exitCode = 1;",
    "    }",
    "  });",
    '  server.listen(PORT, "127.0.0.1", () => {',
    "    console.log(`阅读器已启动: http://127.0.0.1:${PORT}`);",
    "    console.log(`数据目录: ${APP_DIR}`);",
    '    console.log("关闭本窗口即停止阅读器");',
    "    openBrowser();",
    "  });",
    "})();",
  ].join("\n"), "server.listen 启动块");

// 1f. 组装
const bundle = [
  '/* LocalReader 单文件版 —— 由 build/build-exe.mjs 自动生成，请勿直接编辑 */',
  '"use strict";',
  'const http = require("node:http");',
  'const fs = require("node:fs");',
  'const fsp = require("node:fs/promises");',
  'const path = require("node:path");',
  'const sea = require("node:sea");',
  'const { spawn } = require("node:child_process");',
  "",
  "/* ========== 内联资源名映射 ========== */",
  "const SEA_ASSETS = " + JSON.stringify(Object.fromEntries(ASSETS.map(([n]) => [n, n])), null, 2) + ";",
  "",
  "/* ========== parse-core.mjs（内联，已去掉 export） ========== */",
  core.trimEnd(),
  "",
  "/* ========== server.mjs（内联，已改造为单文件版） ========== */",
  srv.trimEnd(),
  ""
].join("\n");

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });
const bundlePath = path.join(TMP, "bundle.cjs");
fs.writeFileSync(bundlePath, bundle, "utf8");
step("生成 bundle.cjs (" + (Buffer.byteLength(bundle) / 1024).toFixed(1) + " KB)");

// 语法自检
const chk = spawnSync(NODE, ["--check", bundlePath], { encoding: "utf8" });
if (chk.status !== 0) fail("bundle 语法检查失败:\n" + chk.stderr);
step("bundle 语法检查通过");

/* ---------------- 2. 生成 SEA blob ---------------- */

const seaCfg = {
  main: bundlePath,
  output: path.join(TMP, "sea.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries(ASSETS.map(([n, rel]) => [n, path.join(ROOT, rel)]))
};
const seaCfgPath = path.join(TMP, "sea-config.json");
fs.writeFileSync(seaCfgPath, JSON.stringify(seaCfg, null, 2), "utf8");

const seaRun = spawnSync(NODE, ["--experimental-sea-config", seaCfgPath], { encoding: "utf8" });
if (seaRun.status !== 0) fail("生成 SEA blob 失败:\n" + (seaRun.stderr || seaRun.stdout));
step("生成 sea.blob (" + (fs.statSync(seaCfg.output).size / 1024).toFixed(1) + " KB)");

/* ---------------- 3. 复制 node.exe + 写入图标/版本 ---------------- */

const exePath = path.join(DIST, APP_NAME + ".exe");
await fsp.copyFile(NODE, exePath);
step("复制 node.exe -> dist/" + APP_NAME + ".exe (" + (fs.statSync(exePath).size / 1048576).toFixed(1) + " MB)");

// 注意：必须在注入 SEA blob 之前改 PE 资源。
// rcedit 对已注入 blob 的 exe 会退化成极慢（实测 20s CPU 仍未完成），
// 对干净 node.exe 只需约 0.5 秒。
if (!SKIP_ICON) {
  const rcedit = await ensureRcedit();
  if (rcedit) {
    const icon = path.join(ROOT, "reader.ico");
    const args = [exePath];
    if (fs.existsSync(icon)) args.push("--set-icon", icon);
    args.push(
      "--set-version-string", "ProductName", "LocalReader",
      "--set-version-string", "FileDescription", "LocalReader 本地小说阅读器",
      "--set-version-string", "CompanyName", "LocalReader",
      "--set-version-string", "LegalCopyright", "MIT License",
      "--set-file-version", VERSION,
      "--set-product-version", VERSION
    );
    const r = spawnSync(rcedit, args, { encoding: "utf8", timeout: 60000 });
    if (r.status === 0) step("写入图标与版本信息");
    else console.log("  图标写入跳过: " + ((r.stderr || "") + (r.error?.message || "")).trim());
  }
}

/* ---------------- 4. 注入 SEA blob ---------------- */

const postjectApi = await ensurePostject();
const blob = await fsp.readFile(seaCfg.output);
try {
  await postjectApi.inject(exePath, "NODE_SEA_BLOB", blob, {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    overwrite: true
  });
} catch (e) { fail("注入 SEA blob 失败: " + e.message); }
step("注入 SEA blob 完成");

/* ---------------- 5. 自检 ---------------- */

const SMOKE_PORT = 7799;
let smokeLog = "";
const smoke = spawn(exePath, [], {
  env: { ...process.env, PORT: String(SMOKE_PORT), LOCALREADER_DATA: path.join(TMP, "smoke-data"), LOCALREADER_NO_BROWSER: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
smoke.stdout.on("data", (d) => { smokeLog += d.toString("utf8"); });
smoke.stderr.on("data", (d) => { smokeLog += d.toString("utf8"); });

function probe(port) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/state", timeout: 1500 }, (r) => {
      let body = "";
      r.on("data", (c) => { body += c; });
      r.on("end", () => resolve(r.statusCode === 200 && body.includes("shelves")));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();   // 必须显式发送，否则请求永远不发出去
  });
}

// 注意：连接被拒（ECONNREFUSED）会立刻返回，所以重试之间必须固定 sleep，
// 否则整个循环在几毫秒内跑完，根本等不到 exe 启动完成。
let ok = false;
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  if (await probe(SMOKE_PORT)) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 400));
}
try { smoke.kill(); } catch {}

if (ok) {
  step("自检通过：exe 启动并正确响应 /api/state");
} else {
  console.log("  自检失败：exe 未在 6 秒内响应端口 " + SMOKE_PORT);
  console.log("  进程输出：\n" + (smokeLog || "(空)"));
  fail("打包产物无法正常启动");
}

/* ---------------- 完成 ---------------- */

const finalSize = fs.statSync(exePath).size;
console.log("");
console.log("打包完成: " + exePath);
console.log("文件大小: " + (finalSize / 1048576).toFixed(1) + " MB");
console.log("");
console.log("分发方式：把这个 exe 单独拷给别人，双击即用（对方无需安装 Node.js）");

/* ---------------- 依赖下载 ---------------- */

async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    step("下载 " + label + " (" + (buf.length / 1048576).toFixed(1) + " MB)");
    return true;
  } catch (e) {
    console.log("  下载 " + label + " 失败: " + e.message);
    return false;
  }
}


async function ensurePostject() {
  const dir = path.join(TMP, "postject");
  const apiPath = path.join(dir, "package/dist/api.js");
  if (!fs.existsSync(apiPath)) {
    const tgz = path.join(TMP, "postject.tgz");
    if (!await download(POSTJECT_URL, tgz, "postject")) fail("无法下载 postject，检查网络");
    fs.mkdirSync(dir, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", tgz, "-C", dir], { encoding: "utf8", shell: false });
    if (tar.status !== 0 || !fs.existsSync(apiPath)) {
      const tar2 = spawnSync("C:\\Windows\\System32\\tar.exe", ["-xzf", tgz, "-C", dir], { encoding: "utf8" });
      if (tar2.status !== 0 || !fs.existsSync(apiPath)) fail("解压 postject 失败");
    }
    step("准备 postject");
  }
  const req = createRequire(path.join(TMP, "anchor.cjs"));
  return req(apiPath);
}

async function ensureRcedit() {
  const rcedit = path.join(TMP, "rcedit-x64.exe");
  if (!await download(RCEDIT_URL, rcedit, "rcedit")) return null;
  return rcedit;
}
