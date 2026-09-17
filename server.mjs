import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBuffer, analyzeText } from "./parse-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "reader.config.json");
const PORT = Number(process.env.PORT || 7788);

/* ---------------- 自定义字体 ---------------- */
const FONT_DIR = path.join(__dirname, "fonts");
try { fs.mkdirSync(FONT_DIR, { recursive: true }); } catch {}
const FONT_EXT = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc"]);
const FONT_MIME = {
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttc": "font/collection"
};

/* ---------------- config ---------------- */

const defaultConfig = {
  shelves: [],
  progress: {},          // rel -> { chapter, scroll }
  fonts: [],             // 自定义字体 [{ id, name, file }]
  settings: {
    theme: "light",
    fontSize: 19,
    lineHeight: 1.9,
    indent: 2,
    fontFamily: "serif",
    maxWidth: 820,
    letterSpacing: 0
  }
};

function dedupeShelves(list) {
  const seen = new Map();
  const out = [];
  for (const s of list) {
    if (!s || !s.path) continue;
    const key = path.resolve(s.path).toLowerCase();
    const hit = seen.get(key);
    if (hit) { hit.count = Math.max(hit.count || 0, s.count || 0); continue; }
    const item = { ...s };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const c = JSON.parse(raw);
    return {
      ...defaultConfig,
      ...c,
      settings: { ...defaultConfig.settings, ...(c.settings || {}) },
      progress: c.progress || {},
      fonts: Array.isArray(c.fonts) ? c.fonts : [],
      shelves: dedupeShelves(Array.isArray(c.shelves) ? c.shelves : [])
    };
  } catch {
    return structuredClone(defaultConfig);
  }
}

let config = loadConfig();
let saveTimer = null;
function saveConfig() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      config.shelves = dedupeShelves(config.shelves);
      await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    }
    catch (e) { console.error("保存配置失败:", e.message); }
  }, 200);
}

/* ---------------- chapter parsing（核心实现见 parse-core.mjs） ---------------- */

const fileCache = new Map(); // absPath -> { key, lines, chapters, pre, encoding, title, author }

function parseBook(absPath) {
  const st = fs.statSync(absPath);
  const key = st.mtimeMs + ":" + st.size;
  const cached = fileCache.get(absPath);
  if (cached && cached.key === key) return cached;

  const buf = fs.readFileSync(absPath);
  const { text, encoding } = decodeBuffer(buf);
  const a = analyzeText(text, path.basename(absPath, path.extname(absPath)));

  const result = {
    key, lines: a.lines, chapters: a.chapters, pre: a.pre, fellBack: a.fellBack,
    encoding, title: a.title, author: a.author, size: st.size
  };
  if (fileCache.size > 40) fileCache.clear();
  fileCache.set(absPath, result);
  return result;
}

/* ---------------- helpers ---------------- */

const TEXT_EXT = new Set([".txt", ".md"]);

function shelfRoot(index) {
  const s = config.shelves[index];
  if (!s) throw new Error("书架不存在");
  return path.resolve(s.path);
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const r = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(r)) throw new Error("路径越界");
  return abs;
}

async function listBooks(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("__")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st; try { st = await fsp.stat(abs); } catch { continue; }
      if (st.size < 1024) continue;
      let author = "";
      try {
        const fd = fs.openSync(abs, "r");
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, 4096, 0);
        fs.closeSync(fd);
        const { text } = decodeBuffer(head.subarray(0, n));
        const m = text.match(/^\s*作者[:：]\s*(.+)$/m);
        if (m) author = m[1].trim().slice(0, 40);
      } catch {}
      out.push({ rel: path.relative(root, abs), name: path.basename(e.name, path.extname(e.name)), size: st.size, mtime: st.mtimeMs, author });
    }
  }
  await walk(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out;
}

function send(res, code, data, type = "application/json; charset=utf-8") {
  const body = type.startsWith("application/json") ? JSON.stringify(data) : data;
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/* ---------------- static ---------------- */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "禁止" });
  try {
    const buf = await fsp.readFile(abs);
    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "未找到" }, "application/json; charset=utf-8");
  }
}

/* ---------------- routes ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  try {
    if (p === "/api/state") {
      return send(res, 200, {
        shelves: config.shelves,
        settings: config.settings,
        progress: config.progress,
        fonts: config.fonts
      });
    }

    if (p === "/api/shelves/add" && req.method === "POST") {
      const { dir } = await readBody(req);
      if (!dir) return send(res, 400, { error: "缺少目录" });
      const abs = path.resolve(dir);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isDirectory()) return send(res, 400, { error: "目录不存在" });
      const key = abs.toLowerCase();
      const dup = config.shelves.findIndex((s) => path.resolve(s.path).toLowerCase() === key);
      if (dup >= 0) return send(res, 200, { ok: true, duplicated: true, index: dup, shelves: config.shelves });
      const books = await listBooks(abs);
      config.shelves.push({ path: abs, name: path.basename(abs) || abs, count: books.length, addedAt: Date.now() });
      saveConfig();
      return send(res, 200, { ok: true, index: config.shelves.length - 1, shelves: config.shelves, count: books.length });
    }

    if (p === "/api/shelves/remove" && req.method === "POST") {
      const { index } = await readBody(req);
      if (typeof index === "number" && config.shelves[index]) {
        config.shelves.splice(index, 1);
        saveConfig();
      }
      return send(res, 200, { ok: true, shelves: config.shelves });
    }

    if (p === "/api/shelves/rename" && req.method === "POST") {
      const { index, name } = await readBody(req);
      if (typeof index === "number" && config.shelves[index] && name) {
        config.shelves[index].name = String(name).slice(0, 60);
        saveConfig();
      }
      return send(res, 200, { ok: true, shelves: config.shelves });
    }

    if (p === "/api/fonts/upload" && req.method === "POST") {
      const { name, data } = await readBody(req);
      if (!data) return send(res, 400, { error: "缺少字体数据" });
      const raw = String(name || "字体.ttf");
      const ext = path.extname(raw).toLowerCase();
      if (!FONT_EXT.has(ext)) return send(res, 400, { error: "仅支持 ttf / otf / woff / woff2 / ttc" });
      const buf = Buffer.from(String(data), "base64");
      if (!buf.length) return send(res, 400, { error: "字体文件为空" });
      if (buf.length > 80 * 1024 * 1024) return send(res, 400, { error: "字体文件过大（>80MB）" });
      const id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = id + ext;
      await fsp.writeFile(path.join(FONT_DIR, file), buf);
      const display = path.basename(raw, ext).slice(0, 60) || "自定义字体";
      config.fonts.push({ id, name: display, file, size: buf.length, addedAt: Date.now() });
      saveConfig();
      return send(res, 200, { ok: true, fonts: config.fonts });
    }

    if (p === "/api/fonts/remove" && req.method === "POST") {
      const { id } = await readBody(req);
      const i = config.fonts.findIndex((f) => f.id === id);
      if (i >= 0) {
        const f = config.fonts[i];
        config.fonts.splice(i, 1);
        try { await fsp.unlink(path.join(FONT_DIR, f.file)); } catch {}
        if (config.settings.fontFamily === "custom:" + id) {
          config.settings.fontFamily = "serif";
          saveConfig();
        }
        saveConfig();
      }
      return send(res, 200, { ok: true, fonts: config.fonts, settings: config.settings });
    }

    if (p === "/api/books") {
      const index = Number(u.searchParams.get("shelf"));
      const root = shelfRoot(index);
      const books = await listBooks(root);
      const s = config.shelves[index];
      if (s) { s.count = books.length; saveConfig(); }
      return send(res, 200, { shelf: config.shelves[index]?.name || "", root, books });
    }

    if (p === "/api/book") {
      const index = Number(u.searchParams.get("shelf"));
      const rel = u.searchParams.get("rel");
      const abs = safeJoin(shelfRoot(index), rel);
      const book = parseBook(abs);
      const list = [];
      if (book.pre) list.push({ title: book.pre.title, idx: -1, kind: "pre" });
      book.chapters.forEach((c, i) => list.push({ title: c.label, idx: i, noHead: !!c.noHead }));
      return send(res, 200, {
        title: book.title,
        author: book.author,
        size: book.size,
        encoding: book.encoding,
        chapterCount: book.chapters.length,
        chapters: list
      });
    }

    if (p === "/api/chapter") {
      const index = Number(u.searchParams.get("shelf"));
      const rel = u.searchParams.get("rel");
      const idx = Number(u.searchParams.get("idx"));
      const abs = safeJoin(shelfRoot(index), rel);
      const book = parseBook(abs);
      const seg = idx === -1 ? book.pre : book.chapters[idx];
      if (!seg) return send(res, 404, { error: "章节不存在" });
      const skipHead = idx === -1 || seg.noHead ? 0 : 1;
      const body = book.lines.slice(seg.start + skipHead, seg.end)
        .map((l) => l.replace(/[\s\u3000]+$/, ""))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
      return send(res, 200, {
        title: idx === -1 ? (book.pre?.title || "简介") : book.chapters[idx].label,
        index: idx,
        total: book.chapters.length,
        text: body
      });
    }

    if (p === "/api/progress" && req.method === "POST") {
      const { rel, chapter, scroll } = await readBody(req);
      if (rel) {
        config.progress[rel] = { chapter: Number(chapter) || 0, scroll: Number(scroll) || 0, at: Date.now() };
        const keys = Object.keys(config.progress);
        if (keys.length > 3000) {
          keys.sort((a, b) => (config.progress[a].at || 0) - (config.progress[b].at || 0))
            .slice(0, 1000).forEach((k) => delete config.progress[k]);
        }
        saveConfig();
      }
      return send(res, 200, { ok: true });
    }

    if (p === "/api/settings" && req.method === "POST") {
      const { settings } = await readBody(req);
      if (settings && typeof settings === "object") {
        config.settings = { ...config.settings, ...settings };
        saveConfig();
      }
      return send(res, 200, { ok: true, settings: config.settings });
    }

    if (p === "/api/browse") {
      // 简易目录浏览，供 GUI 里选文件夹
      const dir = u.searchParams.get("dir");
      const target = dir ? path.resolve(dir) : "";
      if (!target) {
        const drives = [];
        for (const letter of "CDEFGH") {
          try { fs.accessSync(letter + ":\\"); drives.push(letter + ":\\"); } catch {}
        }
        return send(res, 200, { dir: "", parent: null, dirs: drives, files: [] });
      }
      const parent = path.dirname(target);
      const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
      if (!entries) return send(res, 400, { error: "无法读取目录" });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"))
        .map((e) => path.join(target, e.name)).sort((a, b) => a.localeCompare(b, "zh"));
      const files = entries.filter((e) => e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name);
      return send(res, 200, { dir: target, parent: parent === target ? null : parent, dirs, files });
    }

    if (p.startsWith("/fonts/")) {
      const rel = decodeURIComponent(p.slice("/fonts/".length)).replace(/\\/g, "/");
      const abs = path.join(FONT_DIR, path.basename(rel));
      try {
        const buf = await fsp.readFile(abs);
        return send(res, 200, buf, FONT_MIME[path.extname(abs).toLowerCase()] || "font/ttf");
      } catch { return send(res, 404, { error: "字体不存在" }); }
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "未知接口" });
    return await serveStatic(res, p);
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`阅读器已启动: http://127.0.0.1:${PORT}`);
});
