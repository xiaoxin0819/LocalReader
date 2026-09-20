// server.mjs —— 本地阅读器服务端
//
// 与「Reader」项目共用同一套本地阅读逻辑：
//   · legado 替换净化（scope / scopeTitle / scopeContent / order + @js 绑定）
//   · legado TXT 目录规则（正文分章 + 右侧目录栏标题）
// 规则停用 / 取消后，正文与目录标题都恢复原文。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { decodeBuffer, analyzeText } from "./parse-core.mjs";
import { javaRegex, tryJavaRegex } from "./src/java-regex.mjs";
import { replaceWithRule, replaceManyWithRule, RegexTimeoutError } from "./src/replace-engine.mjs";
import { pickTocRule, analyzeByTocRule, makeLineIndexer, tocRuleFingerprint, getTocRules as getEnabledTocRules } from "./src/txt-toc-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * port.txt 的查找目录。
 *
 * 开发模式 = 项目根（与 server.mjs 同级）。
 * exe 模式 = 用户数据目录（build-exe.mjs 会把上一行的 __dirname 整段替换成 APP_DIR，
 * 并把这个常量重新赋值为 APP_DIR）—— 用户在数据目录放 port.txt 即可换端口。
 */
let APP_DIR_FOR_PORT = __dirname;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "reader.config.json");
const SOURCE_DIR = path.join(__dirname, "sources");
const BUILTIN_REPLACE_PATH = path.join(SOURCE_DIR, "builtin-replace-rules.json");
const BUILTIN_TXT_TOC_PATH = path.join(SOURCE_DIR, "builtin-txt-toc-rules.json");

/**
 * 端口解析。优先级（从高到低）：
 *   1. 命令行参数  --port 8080 / -p 8080
 *   2. 环境变量    PORT=8080
 *   3. 配置文件    exe 同级的 port.txt（内容就是一个数字）
 *   4. 默认        7789
 *
 * 为什么需要配置文件：exe 是双击运行的，用户没法方便地设环境变量；
 * 放一个 port.txt 是最直观的做法（记事本改个数字就行）。
 *
 * 支持 0：表示「让系统自动分配空闲端口」，启动日志会打印实际端口。
 * 与 Reader 项目保持同一套语义（两个项目共用同一份使用习惯）。
 */
function resolvePort() {
  const fromArgs = (() => {
    const argv = process.argv.slice(1);
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i]);
      const m = /^--?port[=:]?(\d+)$/i.exec(a) || /^-p(\d+)$/i.exec(a);
      if (m) return m[1];
      if (/^--?port$/i.test(a) || /^-p$/i.test(a)) return argv[i + 1];
    }
    return null;
  })();

  const fromFile = (() => {
    try {
      // exe 模式下 __dirname 被替换成 APP_DIR（用户数据目录），
      // 开发模式下就是项目根 —— 两种情况下 port.txt 都放在「程序所在位置」。
      const p = path.join(APP_DIR_FOR_PORT, "port.txt");
      if (!fs.existsSync(p)) return null;
      const txt = fs.readFileSync(p, "utf8").trim();
      const m = /^(\d{1,5})/.exec(txt);
      return m ? m[1] : null;
    } catch { return null; }
  })();

  const raw = fromArgs || process.env.PORT || fromFile || "7789";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return 7789;
  return n;
}
const PORT = resolvePort();
// 记录用户是否显式指定过端口 —— 决定「端口被占用」时是报错还是自动换一个
const PORT_EXPLICIT = !!(process.argv.slice(1).some((a) => /^--?port|^-p/i.test(String(a)))
  || process.env.PORT
  || (() => { try { return fs.existsSync(path.join(__dirname, "port.txt")); } catch { return false; } })());
// 实际监听端口。PORT 为 0 时由系统分配，listen 回调里回填真实值。
let activePort = PORT;
// legado BookType.localTag：本地书的 origin，用于替换净化的 scope / excludeScope 匹配
const LOCAL_ORIGIN = "loc_book";

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
  },
  // 本地阅读沿用 Reader 的 online.* 规则字段，保证两个项目的规则可互相迁移。
  online: {
    replaceRules: [],                     // 替换净化规则（legado ReplaceRule）
    builtinReplaceInitialized: false,
    builtinReplaceDefaultsMigrated: false,
    builtinReplaceContentMigrated: false,
    builtinReplaceContentSignature: "",
    txtTocRules: [],                      // TXT 目录规则（legado TxtTocRule）
    builtinTxtTocRulesInitialized: false
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
      shelves: dedupeShelves(Array.isArray(c.shelves) ? c.shelves : []),
      online: {
        ...defaultConfig.online,
        ...(c.online || {}),
        replaceRules: Array.isArray(c.online?.replaceRules) ? c.online.replaceRules : [],
        txtTocRules: Array.isArray(c.online?.txtTocRules) ? c.online.txtTocRules : []
      }
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

/** 退出前同步刷盘：saveConfig 有 200ms 防抖，Ctrl+C 会把还没落盘的改动带走 */
function flushConfigNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    config.shelves = dedupeShelves(config.shelves);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (e) { console.error("退出保存配置失败:", e.message); }
}

function loadBuiltinReplaceRules() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_REPLACE_PATH, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && r.pattern).map((r, i) => ({
      ...r,
      id: "builtin-netclean-" + String(r.id == null ? i + 1 : r.id),
      builtin: true,
      builtinSource: "净化合集20条_23.05.05",
    }));
  } catch (e) {
    console.error("读取内置净化规则失败:", e.message);
    return [];
  }
}

const builtinReplaceRules = loadBuiltinReplaceRules();

// 内置净化规则文件的内容签名：文件一改（新增/改写内置规则）就触发一次同步
const BUILTIN_REPLACE_SIGNATURE = crypto
  .createHash("sha1")
  .update(fs.readFileSync(BUILTIN_REPLACE_PATH))
  .digest("hex");

function ensureBuiltinReplaceRules() {
  if (config.online.builtinReplaceInitialized) return false;
  const list = config.online.replaceRules || (config.online.replaceRules = []);
  let maxOrder = list.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
  for (const raw of builtinReplaceRules) {
    if (list.some((r) => String(r.id) === String(raw.id))) continue;
    list.push({ ...raw, order: ++maxOrder });
  }
  config.online.builtinReplaceInitialized = true;
  saveConfig();
  return true;
}
/**
 * 内置净化规则的一次性默认值迁移。
 * 用户确认：源文件 20 条里默认只开启 #01、#13~#17（数字标题 + 净化网址/标点/词语/段落/杂项）。
 * 其余内置规则只作为候选出现，默认关闭；用户自建规则完全不动。
 */
const BUILTIN_REPLACE_ENABLED_IDS = new Set([1, 13, 14, 15, 16, 17]);

function builtinReplaceRuleOrdinal(rule) {
  const m = /^builtin-netclean-(\d+)$/.exec(String((rule && rule.id) || ''));
  return m ? Number(m[1]) : null;
}

function migrateBuiltinReplaceRules() {
  if (config.online.builtinReplaceDefaultsMigrated) return false;
  let changed = false;
  for (const r of config.online.replaceRules || []) {
    const isBuiltin = r && (r.builtin || String(r.id || '').startsWith('builtin-netclean-'));
    if (!isBuiltin) continue;
    const ordinal = builtinReplaceRuleOrdinal(r);
    const want = ordinal != null && BUILTIN_REPLACE_ENABLED_IDS.has(ordinal);
    if (!!r.isEnabled !== want) { r.isEnabled = want; changed = true; }
  }
  config.online.builtinReplaceDefaultsMigrated = true;
  saveConfig();
  if (changed) console.log('内置净化规则默认值已对齐：#01、#13~#17 启用，其余关闭（用户自建规则未改动）');
  return changed;
}

migrateBuiltinReplaceRules();

/* ---- 数字标题规则二选一（内置 #00 / #01 互斥） ----
 * 用户要求：sjshb57 新版数字标题规则与原数字标题规则都保留，
 * 但两条互斥，用户自行选择开启哪一条。
 */
const NUMERIC_TITLE_RULE_IDS = ["builtin-netclean-0", "builtin-netclean-1"];

/** 返回被自动关闭的规则；justEnabledId 为刚刚被用户开启的那条 */
function numericTitleRuleMutex(justEnabledId) {
  const list = config.online.replaceRules || [];
  const pair = NUMERIC_TITLE_RULE_IDS
    .map((id) => list.find((r) => String(r.id) === id))
    .filter(Boolean);
  if (pair.length < 2) return [];
  const enabled = pair.filter((r) => r.isEnabled !== false);
  if (!enabled.length) return [];
  let keep = justEnabledId ? enabled.find((r) => String(r.id) === String(justEnabledId)) : null;
  if (!keep) keep = enabled.slice().sort((a, b) => ruleOrder(a) - ruleOrder(b))[0];
  const turnedOff = [];
  for (const r of enabled) {
    if (r === keep) continue;
    r.isEnabled = false;
    turnedOff.push({ id: r.id, name: r.name });
  }
  return turnedOff;
}

/**
 * 内置净化规则内容同步（签名守卫）。
 * sources/builtin-replace-rules.json 的内容一变，就按 id：
 *   1) 补上 config 里缺失的内置规则（默认开关见 BUILTIN_REPLACE_ENABLED_IDS）
 *   2) 用源文件覆盖内置规则的规则体（原样导入，不做任何改写）
 * 只动内置项：保留用户自己的 isEnabled 开关与 order 排序，用户自建规则完全不动。
 * 同步后强制数字标题两条互斥（见 numericTitleRuleMutex）。
 */
function syncBuiltinReplaceRulesBySignature() {
  if (config.online.builtinReplaceContentSignature === BUILTIN_REPLACE_SIGNATURE) return false;
  ensureBuiltinReplaceRules();
  const list = config.online.replaceRules || (config.online.replaceRules = []);
  const fields = ["group", "name", "pattern", "replacement", "isRegex", "scopeContent", "scopeTitle", "timeoutMillisecond"];
  let added = 0, updated = 0;
  for (const raw of builtinReplaceRules) {
    const id = String(raw.id);
    const cur = list.find((r) => String(r.id) === id);
    if (!cur) {
      // 新内置规则：按序号插队（#00 排在 #01 前面），默认开关沿用内置默认值
      const minOrder = list.length
        ? list.reduce((mn, r) => Math.min(mn, ruleOrder(r)), Infinity)
        : Number(raw.order);
      const wantOrder = Number.isFinite(Number(raw.order)) && Number(raw.order) < minOrder
        ? Number(raw.order)
        : minOrder - 1;
      list.push({
        ...raw,
        isEnabled: BUILTIN_REPLACE_ENABLED_IDS.has(Number(raw.id)),
        order: wantOrder,
      });
      added += 1;
      continue;
    }
    if (!(cur.builtin || id.startsWith("builtin-netclean-"))) continue;
    let diff = false;
    for (const f of fields) {
      if (raw[f] === undefined) continue;
      if (JSON.stringify(cur[f]) !== JSON.stringify(raw[f])) { cur[f] = raw[f]; diff = true; }
    }
    if (diff) updated += 1;
  }
  const turnedOff = numericTitleRuleMutex();
  config.online.builtinReplaceContentSignature = BUILTIN_REPLACE_SIGNATURE;
  saveConfig();
  if (added || updated) {
    console.log(`内置净化规则已同步：新增 ${added} 条 / 更新 ${updated} 条（保留用户开关与排序）`);
  }
  return added + updated > 0 || turnedOff.length > 0;
}

syncBuiltinReplaceRulesBySignature();
/* ---- TXT 目录规则（legado TxtTocRule） ----
 * 字段清单照 data/entities/TxtTocRule.kt：
 *   id / name / rule / replacement / example / serialNumber / enable（+ order 用于排序）
 * 默认 12 条启用、14 条关闭，直接取 legado defaultData/txtTocRule.json，
 * 用户可在「替换净化 → TXT 目录规则」里自行勾选开关。
 */

function loadBuiltinTxtTocRules() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_TXT_TOC_PATH, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && typeof r.rule === "string").map((r, i) => {
      const sn = Number.isFinite(Number(r.serialNumber)) ? Number(r.serialNumber) : i;
      return {
        id: "builtin-toc-" + String(r.id == null ? i + 1 : r.id),
        name: String(r.name || ""),
        rule: String(r.rule || ""),
        replacement: String(r.replacement == null ? "" : r.replacement),
        example: r.example == null ? "" : String(r.example),
        serialNumber: sn,
        enable: r.enable === true,
        order: sn,
        builtin: true,
        builtinSource: "legado 默认 TXT 目录规则",
      };
    });
  } catch (e) {
    console.error("读取内置 TXT 目录规则失败:", e.message);
    return [];
  }
}

const builtinTxtTocRules = loadBuiltinTxtTocRules();

function ensureBuiltinTxtTocRules() {
  if (config.online.builtinTxtTocRulesInitialized) return false;
  const list = config.online.txtTocRules || (config.online.txtTocRules = []);
  for (const raw of builtinTxtTocRules) {
    if (list.some((r) => String(r.id) === String(raw.id))) continue;
    list.push({ ...raw });
  }
  config.online.builtinTxtTocRulesInitialized = true;
  saveConfig();
  return true;
}

/** legado TxtTocRuleDao.enabled：只取 enable == true，按 order 升序 */
function activeTxtTocRules() {
  ensureBuiltinTxtTocRules();
  return getEnabledTocRules(config.online.txtTocRules || []);
}

migrateTxtTocRules();

function migrateTxtTocRules() {
  if (ensureBuiltinTxtTocRules()) {
    console.log("已内置 TXT 目录规则 " + builtinTxtTocRules.length + " 条（默认启用 " +
      builtinTxtTocRules.filter((r) => r.enable).length + " 条，与 legado 一致）");
  }
}
/** legado ReplaceRule.isValid()：pattern 为空直接跳过（ContentProcessor 里 if (item.pattern.isEmpty())） */
function isEmptyPattern(p) {
  return String(p == null ? "" : p).length === 0;
}

/** 把 Java Pattern 编译成 JS 正则（见 src/java-regex.mjs）。 */
function legadoRegex(pattern) {
  return javaRegex(pattern, "g");
}

function ruleOrder(r) {
  const v = Number(r && r.order);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

/**
 * SQLite LIKE 语义（android_metadata 默认 case_sensitive_like = off）：
 *   `%` 任意长度、`_` 单个字符，其余为字面量；ASCII 大小写不敏感。
 * legado ReplaceRuleDao 的 SQL 里直接把书名/书源 URL 拼进 LIKE 模式
 * （`scope LIKE '%' || :name || '%'`），所以这里必须按 LIKE 而不是
 * JS 的 String.includes 来判定，否则空串、通配符、大小写的结果都会不一致。
 */
function sqlLikeMatches(value, pattern) {
  if (value == null) return false; // SQL：NULL LIKE ... → NULL（假）
  let src = "^";
  for (const ch of String(pattern)) {
    if (ch === "%") src += "[\\s\\S]*";
    else if (ch === "_") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  src += "$";
  try { return new RegExp(src, "i").test(String(value)); } catch { return false; }
}

function ruleInScope(r, name, origin) {
  const n = String(name == null ? "" : name);
  const o = String(origin == null ? "" : origin);
  const scope = r.scope == null ? null : String(r.scope);
  // scope LIKE '%name%' OR scope LIKE '%origin%' OR scope IS NULL OR scope = ''
  const scopeHit = scope === null || scope === ""
    || sqlLikeMatches(scope, "%" + n + "%")
    || sqlLikeMatches(scope, "%" + o + "%");
  if (!scopeHit) return false;
  // excludeScope IS NULL OR (excludeScope NOT LIKE '%name%' AND NOT LIKE '%origin%')
  const ex = r.excludeScope == null ? null : String(r.excludeScope);
  if (ex !== null) {
    if (sqlLikeMatches(ex, "%" + n + "%")) return false;
    if (sqlLikeMatches(ex, "%" + o + "%")) return false;
  }
  return true;
}

/** kind = "content" | "title"；对齐 dao 里的 scopeContent / scopeTitle 判定 */
function pickReplaceRules(kind, name, origin) {
  const flag = kind === "title" ? "scopeTitle" : "scopeContent";
  const list = (config.online.replaceRules || []).filter((r) => {
    if (!r || r.isEnabled === false) return false;
    if (!r.pattern) return false;
    // legado 的列默认值：scopeContent 默认 1、scopeTitle 默认 0
    const on = flag === "scopeContent" ? r.scopeContent !== false : r.scopeTitle === true;
    if (!on) return false;
    return ruleInScope(r, name, origin);
  });
  return list.slice().sort((a, b) => ruleOrder(a) - ruleOrder(b));
}

/**
 * 单条规则跑一遍 —— 严格对齐 legado RegexExtensions.kt。
 *
 * 返回 { text, changed }；正则编译失败 / 替换失败都只丢这一条（legado 同款行为）。
 * 超时单独抛 RegexTimeoutError，交给 applyRulesToText 禁用规则并落库。
 */
function runOneRule(text, r, ctx) {
  const c = ctx || {};
  return replaceWithRule({
    name: r.name,
    text,
    pattern: r.pattern,
    replacement: r.replacement,
    isRegex: r.isRegex !== false,
    timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000,
    chapter: c.chapter || null,
    book: c.book || null,
  });
}

/**
 * 逐条应用规则 —— 对齐 ContentProcessor.kt:163-186。
 * 只有输出和输入不同才记为 effective；超时按 legado 关掉该规则并落库。
 */
function applyRulesToText(text, rules, ctx) {
  let out = String(text == null ? "" : text);
  const effective = [];
  for (const r of rules) {
    if (isEmptyPattern(r.pattern)) continue;
    try {
      const next = runOneRule(out, r, ctx);
      if (next !== out) {
        effective.push(r);
        out = next;
      }
    } catch (e) {
      if (e instanceof RegexTimeoutError || (e && e.name === "RegexTimeoutError")) {
        // legado ContentProcessor.kt:181-184：超时 → item.isEnabled = false 并落库
        r.isEnabled = false;
        saveConfig();
        console.error(`[替换净化] ${e.message}，已自动禁用该规则`);
      } else {
        console.error(`替换净化: 规则 ${r.name}替换出错.`, (e && e.message) || e);
      }
    }
  }
  return { text: out, effective };
}

/**
 * 正文替换。opts.bookName / opts.origin 给定时按书源/书名范围过滤（legado ContentProcessor）。
 * 不传时退化为「所有启用的正文规则」——兼容旧调用方。
 * opts.returnMeta=true 时返回 { text, effective }，供调试/统计使用。
 */
function applyReplaceRules(text, opts) {
  const o = opts || {};
  const list = pickReplaceRules("content", o.bookName, o.origin);
  // legado ContentProcessor.kt:160：正文先逐行 trim 再替换
  const src = String(text == null ? "" : text).split("\n").map((l) => l.trim()).join("\n");
  const r = applyRulesToText(src, list, { book: o.book || null, chapter: o.chapter || null });
  return o.returnMeta === true ? r : r.text;
}

/** 标题替换。对齐 BookChapter.getDisplayTitle()：逐条替换，结果非空才采纳。 */
function applyTitleRules(title, bookName, origin, ctx) {
  let t = String(title == null ? "" : title).replace(/[\r\n]/g, "");
  for (const r of pickReplaceRules("title", bookName, origin)) {
    if (isEmptyPattern(r.pattern)) continue;
    try {
      const next = runOneRule(t, r, ctx);
      if (next.trim()) t = next;
    } catch (e) {
      console.error(`替换净化(标题): 规则 ${r.name}替换出错.`, (e && e.message) || e);
    }
  }
  return t;
}

/** 规则内容指纹：任一标题净化规则改变都会让本地目录标题缓存失效。 */
function titleRuleFingerprint(bookName, origin) {
  return pickReplaceRules("title", bookName, origin).map((r) => [
    r.id || "", r.name || "", r.pattern || "", r.replacement || "",
    r.isRegex === false ? "0" : "1", Number(r.timeout) || 0,
  ].join("\u0000")).join("\u0001");
}

/**
 * 批量标题净化：把整本书的标题一次性交给引擎，避免逐章调用 vm 的看门狗开销。
 *
 * 语义与 applyTitleRules 逐条跑完全一致：按规则顺序、结果非空才采纳；
 * 单条规则在该标题上出错时保留该规则执行前的文本（legado 同款）。
 */
function applyTitleRulesBatch(titles, bookName, origin) {
  const rules = pickReplaceRules("title", bookName, origin).filter((r) => !isEmptyPattern(r.pattern));
  let list = titles.map((t) => String(t == null ? "" : t).replace(/[\r\n]/g, ""));
  for (const r of rules) {
    let next;
    try {
      next = replaceManyWithRule({
        name: r.name,
        texts: list,
        pattern: r.pattern,
        replacement: r.replacement,
        isRegex: r.isRegex !== false,
        timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000,
      });
    } catch (e) {
      if (e instanceof RegexTimeoutError || (e && e.name === "RegexTimeoutError")) {
        // legado BookChapter.getDisplayTitle：标题规则超时 → 禁用该规则
        r.isEnabled = false;
        saveConfig();
        console.error(`[替换净化] ${e.message}，已自动禁用该规则`);
        continue;
      }
      console.error(`替换净化(标题): 规则 ${r.name}替换出错.`, (e && e.message) || e);
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const v = next[i];
      if (v == null) continue; // 该标题上失败 → 保留原文（与逐条 catch 后不改 t 一致）
      if (String(v).trim()) list[i] = String(v);
    }
  }
  return list;
}

/** 本地 /api/book 的展示目录。大书有几千章，逐章跑 @js 规则会造成切换书籍明显卡顿。 */
function localDisplayChapters(absPath, book) {
  const bookName = book.title || "";
  const cacheKey = absPath + "\u0002" + (book.key || "") + "\u0002" + titleRuleFingerprint(bookName, LOCAL_ORIGIN);
  const cached = localTitleCache.get(cacheKey);
  if (cached) {
    localTitleCache.delete(cacheKey);
    localTitleCache.set(cacheKey, cached);
    return cached;
  }
  const raws = [];
  if (book.pre) raws.push(book.pre.title);
  book.chapters.forEach((c) => raws.push(c.label));
  const cleaned = applyTitleRulesBatch(raws, bookName, LOCAL_ORIGIN);
  let cursor = 0;
  const list = [];
  if (book.pre) list.push({ title: cleaned[cursor++] || book.pre.title, idx: -1, kind: "pre" });
  book.chapters.forEach((c, i) => list.push({
    title: cleaned[cursor++] || c.label, idx: i, noHead: !!c.noHead, volume: !!c.isVolume,
  }));
  localTitleCache.set(cacheKey, list);
  while (localTitleCache.size > 24) localTitleCache.delete(localTitleCache.keys().next().value);
  return list;
}
/* ============================ 本地书籍解析 ============================ */

const fileCache = new Map();
/** 本地书目录标题缓存：原始标题仍存在 parsed book 中，这里只缓存规则处理后的展示结果。 */
const localTitleCache = new Map();

/** TXT 目录规则变了 → 本地解析缓存必须整体作废，否则右侧目录栏还是旧分章 */
function invalidateFileCache() {
  fileCache.clear();
}

/**
 * 用 legado TXT 目录规则切章（TextFile.analyze(rr)）。
 * 命中规则时按规则切，返回的 start/end 换算成行号；没命中返回 null 走原有兜底。
 */
function analyzeTextWithTocRules(text, fallbackTitle, rules) {
  const rule = pickTocRule(text, rules);
  if (!rule) return null;
  const base = analyzeText(text, fallbackTitle);
  const chips = text.length > 512000 ? text.slice(0, 512000) : text;
  void chips;
  let out;
  try {
    out = analyzeByTocRule(text, rule, { name: base.title, author: base.author });
  } catch (e) {
    console.error("TXT 目录规则切章失败:", e && e.message);
    return null;
  }
  if (!out || !out.chapters.length) return null;
  const lineOf = makeLineIndexer(text);
  const lines = base.lines;
  const chapters = out.chapters.map((c) => {
    const start = Math.max(0, Math.min(lines.length - 1, lineOf(c.start)));
    const end = Math.max(start, Math.min(lines.length, lineOf(c.end)));
    const label = String(c.title == null ? "" : c.title);
    return {
      title: label, label, name: label, num: null,
      start, end, isVolume: !!c.isVolume, noHead: false,
    };
  });
  chapters[chapters.length - 1].end = lines.length;
  let pre = null;
  if (out.intro && out.intro.title) {
    const pe = Math.min(lines.length, lineOf(out.intro.end));
    if (pe > 0) pre = { title: out.intro.title, start: 0, end: pe };
  }
  return {
    lines, chapters, pre, title: base.title, author: base.author,
    fellBack: false, ruleName: rule.name,
  };
}

function parseBook(absPath) {
  const st = fs.statSync(absPath);
  const rules = activeTxtTocRules();
  const fp = tocRuleFingerprint(rules);
  const key = st.mtimeMs + ":" + st.size + ":" + fp;
  const cached = fileCache.get(absPath);
  if (cached && cached.key === key) {
    // 命中时刷新 LRU 顺序，避免切换几十本后再回来重复解析。
    fileCache.delete(absPath);
    fileCache.set(absPath, cached);
    return cached;
  }
  const buf = fs.readFileSync(absPath);
  const { text, encoding } = decodeBuffer(buf);
  const fallbackTitle = path.basename(absPath, path.extname(absPath));
  const a = analyzeTextWithTocRules(text, fallbackTitle, rules) || analyzeText(text, fallbackTitle);
  const result = {
    key, lines: a.lines, chapters: a.chapters, pre: a.pre, fellBack: a.fellBack,
    encoding, title: a.title, author: a.author, size: st.size, tocRule: a.ruleName || ""
  };
  fileCache.delete(absPath);
  fileCache.set(absPath, result);
  while (fileCache.size > 40) fileCache.delete(fileCache.keys().next().value);
  return result;
}
/* ---------------- 中间层：静态资源 / 目录扫描 ---------------- */

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

/* ---------------- 书架列表缓存 ----------------
 * 列书架最慢的一步不是 readdir，而是逐本打开文件读 4KB 取「作者:」（D 盘大书架上冷启动能到数秒）。
 * 这里按 (mtime+size) 把作者结果持久化到 .cache/authors.json：只有文件真的改过才重读，
 * 重启服务后依然命中，配合前端占位提示，冷启动不再一片空白。
 */
const CACHE_DIR = path.join(__dirname, ".cache");
const AUTHOR_CACHE_PATH = path.join(CACHE_DIR, "authors.json");
const AUTHOR_CACHE_MAX = 60000;
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
const authorCache = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(AUTHOR_CACHE_PATH, "utf8"));
  for (const [k, v] of Object.entries(raw || {})) {
    if (v && typeof v.sig === "string" && typeof v.author === "string") authorCache.set(k, v);
  }
} catch {}
let authorCacheTimer = null;
let authorCacheDirty = false;
function saveAuthorCacheSoon() {
  if (!authorCacheDirty || authorCacheTimer) return;
  authorCacheTimer = setTimeout(async () => {
    authorCacheTimer = null;
    if (!authorCacheDirty) return;
    authorCacheDirty = false;
    try {
      await fsp.writeFile(AUTHOR_CACHE_PATH, JSON.stringify(Object.fromEntries(authorCache)), "utf8");
    } catch (e) { console.error("保存作者缓存失败:", e.message); }
  }, 1500);
}

/** rel 目录列表的短 TTL 缓存：刷新页面 / 连续切书架时不必重复遍历同一目录 */
const bookListCache = new Map();
const BOOKLIST_TTL = 1500;

/* ---------------- 书架快照（stale-while-revalidate） ----------------
 * 书架常放在 USB 移动硬盘上，Windows 空闲一段时间（默认 20 分钟）就会让盘休眠。
 * 服务重启后内存缓存必然是空的，此时第一次列书架要等磁盘唤醒 + 全目录 stat，
 * 用户看到的就是「每次打开阅读器都要等书架转出来」。
 * 这里把上次成功的列表落盘到 C: 的 .cache 里：进程刚起来时先秒回快照，
 * 后台再重扫校正。磁盘慢慢转，界面不用等。
 */
const BOOKLIST_SNAPSHOT_DIR = path.join(CACHE_DIR, "booklist");
const BOOKLIST_SNAPSHOT_MAX_AGE = 7 * 24 * 3600 * 1000;
try { fs.mkdirSync(BOOKLIST_SNAPSHOT_DIR, { recursive: true }); } catch {}

function snapshotFileOf(root) {
  const h = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(BOOKLIST_SNAPSHOT_DIR, h + ".json");
}

function readBookSnapshot(root) {
  try {
    const j = JSON.parse(fs.readFileSync(snapshotFileOf(root), "utf8"));
    if (!j || !Array.isArray(j.books) || !j.books.length) return null;
    if (Date.now() - Number(j.at || 0) > BOOKLIST_SNAPSHOT_MAX_AGE) return null;
    if (path.resolve(String(j.root || "")) !== path.resolve(root)) return null;
    return j;
  } catch { return null; }
}

const pendingSnapshots = new Map();
let snapshotTimer = null;
function saveBookSnapshotSoon(root, books) {
  const abs = path.resolve(root);
  pendingSnapshots.set(abs, { root: abs, books });
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    const items = [...pendingSnapshots.values()];
    pendingSnapshots.clear();
    for (const it of items) {
      try {
        await fsp.writeFile(snapshotFileOf(it.root), JSON.stringify({ at: Date.now(), root: it.root, books: it.books }), "utf8");
      } catch (e) { console.error("保存书架快照失败:", e.message); }
    }
  }, 400);
}

/** 书架被移除时顺手删掉快照，免得重新导入时先闪出旧列表 */
function dropBookSnapshot(root) {
  try { fs.unlinkSync(snapshotFileOf(root)); } catch {}
}

/** 后台重扫：磁盘慢慢转，先让用户看到上次的结果 */
function revalidateBookList(root, ck) {
  const cur = bookListCache.get(ck);
  if (cur && cur.revalidating) return;
  bookListCache.set(ck, { ...(cur || { at: 0, books: [] }), revalidating: true });
  listBooksUncached(root).then((books) => {
    bookListCache.set(ck, { at: Date.now(), books });
    if (bookListCache.size > 32) bookListCache.delete(bookListCache.keys().next().value);
    saveBookSnapshotSoon(root, books);
  }).catch((e) => {
    const s = bookListCache.get(ck);
    if (s) s.revalidating = false;
    console.error("重扫书架失败:", e && e.message);
  });
}

/** 返回 { books, stale }：stale=true 表示这是上次的结果，后台正在校正 */
async function listBooksWithMeta(root, opts = {}) {
  const ck = path.resolve(root).toLowerCase();
  const hit = bookListCache.get(ck);
  if (!opts.fresh) {
    if (hit && hit.at > 0) {
      if (Date.now() - hit.at < BOOKLIST_TTL) return { books: hit.books, stale: false };
      revalidateBookList(root, ck);
      return { books: hit.books, stale: true };
    }
    if (hit && hit.books && hit.books.length) {      // 快照已回，后台还在校正
      revalidateBookList(root, ck);
      return { books: hit.books, stale: true };
    }
    const snap = readBookSnapshot(root);
    if (snap) {
      bookListCache.set(ck, { at: 0, books: snap.books });
      revalidateBookList(root, ck);
      return { books: snap.books, stale: true };
    }
  }
  const books = await listBooksUncached(root);
  bookListCache.set(ck, { at: Date.now(), books });
  if (bookListCache.size > 32) bookListCache.delete(bookListCache.keys().next().value);
  saveBookSnapshotSoon(root, books);
  return { books, stale: false };
}

async function listBooks(root, opts = {}) {
  return (await listBooksWithMeta(root, opts)).books;
}

function invalidateBookListCache() {
  bookListCache.clear();
}

async function listBooksUncached(root) {
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
      const sig = Math.round(st.mtimeMs) + ":" + st.size;
      const authorKey = abs.toLowerCase();
      const cachedAuthor = authorCache.get(authorKey);
      let author;
      if (cachedAuthor && cachedAuthor.sig === sig) {
        author = cachedAuthor.author;
      } else {
        author = "";
        try {
          const fd = fs.openSync(abs, "r");
          const head = Buffer.alloc(4096);
          const n = fs.readSync(fd, head, 0, 4096, 0);
          fs.closeSync(fd);
          const { text } = decodeBuffer(head.subarray(0, n));
          const m = text.match(/^\s*作者[:：]\s*(.+)$/m);
          if (m) author = m[1].trim().slice(0, 40);
        } catch {}
        authorCache.delete(authorKey);                 // 重新插入，保证 LRU 顺序
        authorCache.set(authorKey, { sig, author });
        while (authorCache.size > AUTHOR_CACHE_MAX) authorCache.delete(authorCache.keys().next().value);
        authorCacheDirty = true;
      }
      out.push({ rel: path.relative(root, abs), name: path.basename(e.name, path.extname(e.name)), size: st.size, mtime: st.mtimeMs, author });
    }
  }
  await walk(root, 0);
  if (authorCacheDirty) saveAuthorCacheSoon();
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
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch { return send(res, 403, { error: "禁止" }); }
  if (rel === "/" || rel === "") rel = "/index.html";
  const abs = path.join(PUBLIC_DIR, rel);
  const relFromPublic = path.relative(PUBLIC_DIR, abs);
  const insidePublic = relFromPublic !== "" && relFromPublic !== ".."
    && !relFromPublic.startsWith(`..${path.sep}`) && !path.isAbsolute(relFromPublic);
  if (!insidePublic) return send(res, 403, { error: "禁止" });
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
      invalidateBookListCache();
      saveConfig();
      return send(res, 200, { ok: true, index: config.shelves.length - 1, shelves: config.shelves, count: books.length });
    }

    if (p === "/api/shelves/remove" && req.method === "POST") {
      const { index } = await readBody(req);
      if (typeof index === "number" && config.shelves[index]) {
        dropBookSnapshot(config.shelves[index].path);
        config.shelves.splice(index, 1);
        invalidateBookListCache();
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
      // 快照命中时先回上次结果（stale），后台重扫；前端据此决定要不要再拉一次
      const { books, stale } = await listBooksWithMeta(root);
      const s = config.shelves[index];
      // 只有数量真的变了才落盘：reader.config.json 有 150KB+，每次列书架都写一遍纯属浪费
      if (!stale && s && s.count !== books.length) { s.count = books.length; saveConfig(); }
      return send(res, 200, { shelf: config.shelves[index]?.name || "", root, books, stale });
    }

    if (p === "/api/book") {
      const index = Number(u.searchParams.get("shelf"));
      const rel = u.searchParams.get("rel");
      const abs = safeJoin(shelfRoot(index), rel);
      const book = parseBook(abs);
      // 与 legado LocalBook.getChapterList（BookChapter.getDisplayTitle）对齐：
      // 本地书目录标题同样套用 scopeTitle 替换规则；规则结果按书/规则指纹缓存。
      const list = localDisplayChapters(abs, book);
      return send(res, 200, {
        title: book.title, author: book.author, size: book.size, encoding: book.encoding,
        chapterCount: book.chapters.length, chapters: list, tocRule: book.tocRule || ""
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
      // 卷标题（legado BookChapter.isVolume）本身没有正文，别把下一章的内容算进来
      const skipHead = idx === -1 || seg.noHead ? 0 : 1;
      const rawTitle = idx === -1 ? (book.pre?.title || "简介") : book.chapters[idx].label;
      const bn = book.title || "";
      const title = applyTitleRules(rawTitle, bn, LOCAL_ORIGIN) || rawTitle;
      const rawBody = seg.isVolume ? "" : book.lines.slice(seg.start + skipHead, seg.end)
        .map((l) => l.replace(/[\s\u3000]+$/, ""))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
      // 与 legado ReadBook.kt:798-805（ContentProcessor.getContent）对齐：
      // 本地书正文同样跑一遍替换净化，规则取消/停用即恢复原文。
      const body = seg.isVolume ? "" : applyReplaceRules(rawBody, {
        bookName: bn, origin: LOCAL_ORIGIN, book: bn, chapter: title,
      });
      return send(res, 200, {
        title, index: idx, total: book.chapters.length, text: body, isVolume: !!seg.isVolume
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

    /* ---------------- 替换规则（legado ReplaceRuleController + ReplaceRuleActivity） ----------------
     * 字段清单严格照 data/entities/ReplaceRule.kt：
     *   id/name/group/pattern/replacement/scope/scopeTitle/scopeContent/
     *   excludeScope/isEnabled/isRegex/timeoutMillisecond/order
     * order 语义照 dao：MIN_VALUE 表示「没排过序」，落库时取 maxOrder+1（Controller.saveRule）。
     */

    /** 是否有用的规则；对齐 ReplaceRule.isValid() */
    function replaceRuleValid(rule) {
      const pattern = String(rule.pattern == null ? "" : rule.pattern);
      if (!pattern) return false;
      if (rule.isRegex !== false) {
        try { legadoRegex(pattern); } catch (e) { return false; }
        if (/\|$/.test(pattern) && !/\\\|$/.test(pattern)) return false; // legado: endsWith('|') && !endsWith('\|')
      }
      return true;
    }

    /** 统一成完整形状；order 缺省 = Int.MIN_VALUE（未排序） */
    function normReplaceRule(rule, fallbackOrder) {
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
      return {
        id: rule.id || ("r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: String(rule.name || ""),
        group: rule.group == null ? "" : String(rule.group),
        pattern: String(rule.pattern == null ? "" : rule.pattern),
        replacement: String(rule.replacement == null ? "" : rule.replacement),
        scope: rule.scope == null ? "" : String(rule.scope),
        scopeTitle: rule.scopeTitle === true,
        scopeContent: rule.scopeContent !== false,
        excludeScope: rule.excludeScope == null ? "" : String(rule.excludeScope),
        isEnabled: rule.isEnabled !== false,
        isRegex: rule.isRegex !== false,
        timeoutMillisecond: num(rule.timeoutMillisecond, 3000),
        order: Number.isFinite(Number(rule.order)) ? Number(rule.order) : (fallbackOrder == null ? Number.MIN_SAFE_INTEGER : fallbackOrder),
        builtin: rule.builtin === true,
        builtinSource: rule.builtinSource ? String(rule.builtinSource) : "",
      };
    }

    function sortedRules() {
      return (config.online.replaceRules || []).slice().sort((x, y) => ruleOrder(x) - ruleOrder(y));
    }

    if (p === "/api/replace-rules" && req.method === "GET") {
      ensureBuiltinReplaceRules();
      return send(res, 200, { rules: sortedRules() });
    }

    if (p === "/api/replace-rules/builtin/reset" && req.method === "POST") {
      const old = new Map((config.online.replaceRules || []).map((r) => [String(r.id), r]));
      const custom = (config.online.replaceRules || []).filter((r) => !r.builtin && !String(r.id).startsWith("builtin-netclean-"));
      let maxOrder = custom.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
      const restored = builtinReplaceRules.map((r) => {
        const prev = old.get(String(r.id));
        return { ...r, isEnabled: prev ? prev.isEnabled !== false : r.isEnabled !== false, order: ++maxOrder };
      });
      config.online.replaceRules = custom.concat(restored);
      config.online.builtinReplaceInitialized = true;
      const mutexDisabled = numericTitleRuleMutex();
      saveConfig();
      return send(res, 200, { ok: true, count: restored.length, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/save" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule || body;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      const list = config.online.replaceRules;
      const i = rule.id ? list.findIndex((r) => r.id === rule.id) : -1;
      if (!replaceRuleValid(rule)) return send(res, 200, { ok: false, error: "替换规则为空或者不满足正则表达式要求" });
      // ReplaceRuleController.saveRule：order == Int.MIN_VALUE 时取 maxOrder+1
      let order = rule.order;
      if (!Number.isFinite(Number(order))) {
        order = list.reduce((mx, r) => Math.max(mx, Number.isFinite(Number(r.order)) ? Number(r.order) : 0), 0) + 1;
      }
      const item = normReplaceRule(rule, order);
      if (i >= 0) item.id = list[i].id;
      if (i >= 0) list[i] = item; else list.push(item);
      const mutexDisabled = item.isEnabled === false ? [] : numericTitleRuleMutex(item.id);
      saveConfig();
      return send(res, 200, { ok: true, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/delete" && req.method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      config.online.replaceRules = config.online.replaceRules.filter((r) => !ids.includes(r.id));
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules() });
    }

    /** 置顶 / 置底 / 全量重排 —— 对齐 ReplaceRuleViewModel.toTop/toBottom/upOrder */
    if (p === "/api/replace-rules/order" && req.method === "POST") {
      const body = await readBody(req);
      const list = config.online.replaceRules;
      const act = String(body.action || "");
      if (act === "reindex") {                       // upOrder(): 按当前顺序重编号 1..n
        sortedRules().forEach((r, i) => { r.order = i + 1; });
      } else if (Array.isArray(body.urls || body.ids)) {
        const seq = body.ids || body.urls;           // 拖拽排序：按下标写 order
        const idx = new Map(seq.map((u, i) => [String(u), i + 1]));
        for (const r of list) if (idx.has(String(r.id))) r.order = idx.get(String(r.id));
      } else {
        const r = list.find((x) => x.id === body.id);
        if (!r) return send(res, 404, { error: "规则不存在" });
        if (act === "top") {
          r.order = list.reduce((mn, x) => Math.min(mn, ruleOrder(x)), ruleOrder(r)) - 1;
        } else if (act === "bottom") {
          r.order = list.reduce((mx, x) => Math.max(mx, ruleOrder(x)), ruleOrder(r)) + 1;
        } else {
          return send(res, 400, { error: "未知操作" });
        }
      }
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules() });
    }

    /** 批量启用 / 禁用（legado enableSelection / disableSelection） */
    if (p === "/api/replace-rules/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      for (const r of config.online.replaceRules) if (ids.includes(r.id)) r.isEnabled = body.enabled !== false;
      const mutexDisabled = body.enabled === false ? [] : numericTitleRuleMutex(ids.find((id) => NUMERIC_TITLE_RULE_IDS.includes(String(id))));
      saveConfig();
      return send(res, 200, { ok: true, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/test" && req.method === "POST") {
      // legado ReplaceRuleController.testRule：入参 { rule, text }，rule 可以是对象或 JSON 串
      const body = await readBody(req);
      let rule = body.rule;
      if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
      if (!rule || typeof rule !== "object") {
        // 兼容旧前端的三段式入参
        rule = { pattern: body.pattern, replacement: body.replacement, isRegex: body.isRegex };
      }
      if (!replaceRuleValid(rule)) return send(res, 200, { ok: false, error: "替换规则为空或者不满足正则表达式要求" });
      const text = String(body.text == null ? "" : body.text);
      if (!text) return send(res, 200, { ok: false, error: "请先打开一章正文再测试" });
      const timeout = Number(rule.timeoutMillisecond) > 0 ? Number(rule.timeoutMillisecond) : 3000;
      try {
        const out = runOneRule(text, rule);
        return send(res, 200, { ok: true, text: out, timeoutMillisecond: timeout });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }

    /* ---------------- 替换规则导入（legado ReplaceAnalyzer + ImportReplaceRuleDialog） ----------------
     * 支持两种 JSON 形状（对齐 ReplaceAnalyzer.jsonToReplaceRule）：
     *   1) 本项目的完整形状：{ id, name, group, pattern, replacement, scope, scopeTitle,
     *      scopeContent, excludeScope, isEnabled, isRegex, timeoutMillisecond, order }
     *   2) legado 老版共享格式：{ id, regex, replaceSummary, replacement, isRegex, useTo, enable, serialNumber }
     * pattern 为空时才走老格式；老格式里 regex 也为空 → 该条丢弃（格式不对）。
     */

    /** 单条：JSON 对象 → 规则；不合法返回 null */
    function parseOneReplaceRule(raw) {
      if (!raw || typeof raw !== "object") return null;
      const hasPattern = String(raw.pattern == null ? "" : raw.pattern).length > 0;
      let rule;
      if (hasPattern) {
        rule = normReplaceRule(raw, Number(raw.order));
      } else {
        const legacy = {
          id: raw.id,
          pattern: String(raw.regex == null ? "" : raw.regex),
          name: String(raw.replaceSummary == null ? "" : raw.replaceSummary),
          replacement: String(raw.replacement == null ? "" : raw.replacement),
          isRegex: raw.isRegex === true,
          scope: raw.useTo == null ? "" : String(raw.useTo),
          isEnabled: raw.enable === true,
          order: Number(raw.serialNumber),
        };
        if (!legacy.pattern) return null;
        rule = normReplaceRule(legacy, legacy.order);
      }
      if (!replaceRuleValid(rule)) return null;
      return rule;
    }

    /** 文本 → 规则数组。JSON 数组 / JSON 对象 / 单个对象都接受 */
    function parseReplaceRulesText(text) {
      const t = String(text == null ? "" : text).trim();
      let data;
      try { data = JSON.parse(t); }
      catch { throw new Error("格式不对"); }
      const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.replaceRules) ? data.replaceRules
          : (data && Array.isArray(data.data) ? data.data : [data]));
      const out = [];
      for (const item of arr) { const r = parseOneReplaceRule(item); if (r) out.push(r); }
      if (!out.length) throw new Error("格式不对");
      return out;
    }

    /** URL → 文本；对齐 legado：以 #requestWithoutUA 结尾时不带 UA 请求 */
    async function fetchReplaceRulesText(url) {
      const raw = String(url || "").trim();
      if (!/^https?:\/\//i.test(raw)) throw new Error("仅支持 http(s) 地址");
      const noUA = raw.endsWith("#requestWithoutUA");
      const target = noUA ? raw.slice(0, -"#requestWithoutUA".length) : raw;
      const headers = noUA ? {} : { "user-agent": "Mozilla/5.0" };
      const r = await fetch(target, { headers });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    }

    /** 预览：列出规则 + 库里是否已有同 id（legado ReplaceRuleImportComparison） */
    if (p === "/api/replace-rules/preview" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        const rules = parseReplaceRulesText(text);
        const list = rules.map((r) => {
          const old = (config.online.replaceRules || []).find((x) => x.id === r.id);
          let state = "新增";
          if (old) {
            state = (old.pattern !== r.pattern || String(old.replacement) !== String(r.replacement)
              || old.isRegex !== r.isRegex || String(old.scope || "") !== String(r.scope || "")) ? "更新" : "已有";
          }
          return {
            id: r.id, name: r.name, group: r.group || "", pattern: r.pattern,
            replacement: r.replacement, isRegex: r.isRegex, isEnabled: r.isEnabled,
            scope: r.scope || "", exists: !!old, state,
          };
        });
        return send(res, 200, { ok: true, rules: list });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === "/api/replace-rules/import" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        let rules = parseReplaceRulesText(text);
        if (Array.isArray(body.ids)) {
          const want = new Set(body.ids.map(String));
          rules = rules.filter((r) => want.has(String(r.id)));
        }
        const list = config.online.replaceRules;
        let added = 0, updated = 0;
        const group = String(body.group || "").trim();
        for (const r of rules) {
          if (group) {
            if (body.addGroup === true) {
              const gs = String(r.group || "").split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
              if (!gs.includes(group)) gs.push(group);
              r.group = gs.join(",");
            } else {
              r.group = group;
            }
          }
          const i = list.findIndex((x) => x.id === r.id);
          if (i >= 0) { r.order = Number.isFinite(Number(list[i].order)) ? list[i].order : r.order; list[i] = r; updated++; }
          else {
            if (!Number.isFinite(Number(r.order))) {
              r.order = list.reduce((mx, x) => Math.max(mx, Number.isFinite(Number(x.order)) ? Number(x.order) : 0), 0) + 1;
            }
            list.push(r); added++;
          }
        }
        const mutexDisabled = numericTitleRuleMutex();
        saveConfig();
        return send(res, 200, { ok: true, added, updated, mutexDisabled, rules: sortedRules() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    /** 分组：全部分组名（对齐 ReplaceRuleDao.allGroups：按 [,;，；] 拆 + 去重 + 中文排序） */
    function replaceRuleGroups() {
      const set = [];
      for (const r of config.online.replaceRules || []) {
        for (const g of String(r.group == null ? "" : r.group).split(/[,;，；]/)) {
          const t = g.trim();
          if (t && !set.includes(t)) set.push(t);
        }
      }
      return set.sort((a, b) => String(a).localeCompare(String(b), "zh"));
    }

    if (p === "/api/replace-rules/groups" && req.method === "GET") {
      return send(res, 200, { groups: replaceRuleGroups() });
    }

    /** 分组管理：addGroup / upGroup / delGroup（对齐 ReplaceRuleViewModel） */
    if (p === "/api/replace-rules/group" && req.method === "POST") {
      const body = await readBody(req);
      const act = String(body.action || "");
      const list = config.online.replaceRules || [];
      const splitG = (v) => String(v == null ? "" : v).split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
      if (act === "add") {                                  // addGroup：未分组的全部并入该分组
        const g = String(body.group || "").trim();
        if (!g) return send(res, 400, { error: "分组名为空" });
        for (const r of list) if (!splitG(r.group).length) r.group = g;
      } else if (act === "rename") {                        // upGroup：精确成员替换（renameGroupExact）
        const oldG = String(body.oldGroup || "");
        const newG = String(body.newGroup == null ? "" : body.newGroup);
        for (const r of list) {
          const gs = splitG(r.group);
          if (!gs.includes(oldG)) continue;
          const next = gs.filter((x) => x !== oldG);
          for (const ng of splitG(newG)) if (!next.includes(ng)) next.push(ng);
          r.group = next.join(",");
        }
      } else if (act === "delete") {                        // delGroup：移除成员，分组没了就是空了
        const g = String(body.group || "");
        for (const r of list) {
          const gs = splitG(r.group);
          if (!gs.includes(g)) continue;
          r.group = gs.filter((x) => x !== g).join(",");
        }
      } else return send(res, 400, { error: "未知操作" });
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules(), groups: replaceRuleGroups() });
    }


    /* ---------------- TXT 目录规则（legado TxtTocRuleController + TxtTocRuleActivity） ----------------
     * 字段清单照 data/entities/TxtTocRule.kt：
     *   id / name / rule / replacement / example / serialNumber / enable（+ order 供排序）
     * 与替换净化同一套交互：搜索 / 勾选 / 启用开关 / 置顶置底 / 删除 / 导入导出 / 恢复默认。
     */

    function txtTocRuleOrder(r) {
      const o = Number(r.order);
      if (Number.isFinite(o)) return o;
      const sn = Number(r.serialNumber);
      return Number.isFinite(sn) ? sn : 0;
    }

    function sortedTxtTocRules() {
      return (config.online.txtTocRules || []).slice().sort((a, b) => txtTocRuleOrder(a) - txtTocRuleOrder(b));
    }

    /** 统一成完整形状；enable 与 legado 同名，不做 isEnabled 映射 */
    function normTxtTocRule(rule, fallbackOrder) {
      const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
      return {
        id: rule.id || ("toc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: String(rule.name || ""),
        rule: String(rule.rule == null ? "" : rule.rule),
        replacement: String(rule.replacement == null ? "" : rule.replacement),
        example: rule.example == null ? "" : String(rule.example),
        serialNumber: num(rule.serialNumber, 0),
        enable: rule.enable !== false,
        order: Number.isFinite(Number(rule.order)) ? Number(rule.order)
          : (fallbackOrder == null ? Number.MIN_SAFE_INTEGER : fallbackOrder),
        builtin: rule.builtin === true,
        builtinSource: rule.builtinSource ? String(rule.builtinSource) : "",
      };
    }

    /** 规则可用性：legado TxtTocRule 允许 rule 为空（默认分章规则），只要求 replacement 语法合法 */
    function txtTocRuleValid(rule) {
      const js = String(rule.replacement == null ? "" : rule.replacement);
      if (js) { try { new vm.Script("(function(){ return eval(" + JSON.stringify(js) + "); })"); } catch (e) { return false; } }
      const re = String(rule.rule == null ? "" : rule.rule);
      if (re && !tryJavaRegex(re, "gm")) return false;
      return true;
    }

    if (p === "/api/txt-toc-rules" && req.method === "GET") {
      ensureBuiltinTxtTocRules();
      return send(res, 200, { rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/builtin/reset" && req.method === "POST") {
      const old = new Map((config.online.txtTocRules || []).map((r) => [String(r.id), r]));
      const custom = (config.online.txtTocRules || []).filter((r) => !r.builtin && !String(r.id).startsWith("builtin-toc-"));
      const restored = builtinTxtTocRules.map((r) => {
        const prev = old.get(String(r.id));
        return { ...r, enable: prev ? prev.enable === true : r.enable === true };
      });
      config.online.txtTocRules = custom.concat(restored);
      config.online.builtinTxtTocRulesInitialized = true;
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, count: restored.length, rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/save" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule || body;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      if (!txtTocRuleValid(rule)) return send(res, 200, { ok: false, error: "规则的正则或 JS 语法不合法" });
      const list = config.online.txtTocRules;
      const i = rule.id ? list.findIndex((r) => String(r.id) === String(rule.id)) : -1;
      let order = rule.order;
      if (!Number.isFinite(Number(order))) {
        order = list.reduce((mx, r) => Math.max(mx, Number.isFinite(Number(r.order)) ? Number(r.order) : 0), 0) + 1;
      }
      const item = normTxtTocRule(rule, order);
      if (i >= 0) item.id = list[i].id;
      if (i >= 0) list[i] = item; else list.push(item);
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/delete" && req.method === "POST") {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String);
      config.online.txtTocRules = (config.online.txtTocRules || []).filter((r) => !ids.includes(String(r.id)));
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 置顶 / 置底 / 全量重排 —— 对齐 TxtTocRuleViewModel.toTop/toBottom/upOrder */
    if (p === "/api/txt-toc-rules/order" && req.method === "POST") {
      const body = await readBody(req);
      const list = config.online.txtTocRules || [];
      const act = String(body.action || "");
      if (act === "reindex") {
        sortedTxtTocRules().forEach((r, i) => { r.order = i + 1; });
      } else if (Array.isArray(body.ids)) {
        const idx = new Map(body.ids.map((u, i) => [String(u), i + 1]));
        for (const r of list) if (idx.has(String(r.id))) r.order = idx.get(String(r.id));
      } else {
        const r = list.find((x) => String(x.id) === String(body.id));
        if (!r) return send(res, 404, { error: "规则不存在" });
        if (act === "top") r.order = list.reduce((mn, x) => Math.min(mn, txtTocRuleOrder(x)), txtTocRuleOrder(r)) - 1;
        else if (act === "bottom") r.order = list.reduce((mx, x) => Math.max(mx, txtTocRuleOrder(x)), txtTocRuleOrder(r)) + 1;
        else return send(res, 400, { error: "未知操作" });
      }
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 批量启用 / 禁用（legado enableSelection / disableSelection） */
    if (p === "/api/txt-toc-rules/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String);
      for (const r of config.online.txtTocRules || []) if (ids.includes(String(r.id))) r.enable = body.enabled !== false;
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 单条规则试切：拿一段文本看它匹配出多少章 */
    if (p === "/api/txt-toc-rules/test" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      const text = String(body.text == null ? "" : body.text);
      if (!text) return send(res, 200, { ok: false, error: "请先打开一本本地 txt 再测试" });
      if (!txtTocRuleValid(rule)) return send(res, 200, { ok: false, error: "规则的正则或 JS 语法不合法" });
      try {
        const r = analyzeByTocRule(text, { rule: String(rule.rule || ""), replacement: String(rule.replacement || "") }, null);
        const titles = (r.chapters || []).slice(0, 30).map((c) => c.title);
        return send(res, 200, { ok: true, count: (r.chapters || []).length, titles });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }

    /** 导入：JSON 形状照 TxtTocRule.kt（也接受 legado 老版 txtTocRule 分享格式） */
    function parseTxtTocRulesText(text) {
      const t = String(text == null ? "" : text).trim();
      let data;
      try { data = JSON.parse(t); } catch { throw new Error("格式不对"); }
      const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.rules) ? data.rules
          : (data && Array.isArray(data.data) ? data.data : [data]));
      const out = [];
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const rule = normTxtTocRule({
          id: raw.id,
          name: raw.name == null ? "" : raw.name,
          rule: raw.rule == null ? "" : raw.rule,
          replacement: raw.replacement == null ? "" : raw.replacement,
          example: raw.example == null ? "" : raw.example,
          serialNumber: raw.serialNumber,
          enable: raw.enable === true,
          order: Number(raw.serialNumber),
        }, Number(raw.serialNumber));
        if (txtTocRuleValid(rule)) out.push(rule);
      }
      if (!out.length) throw new Error("格式不对");
      return out;
    }

    if (p === "/api/txt-toc-rules/preview" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        const rules = parseTxtTocRulesText(text);
        const list = rules.map((r) => {
          const old = (config.online.txtTocRules || []).find((x) => String(x.id) === String(r.id));
          let state = "新增";
          if (old) state = (String(old.rule) !== r.rule || String(old.replacement) !== r.replacement) ? "更新" : "已有";
          return { id: r.id, name: r.name, rule: r.rule, replacement: r.replacement,
            example: r.example, enable: r.enable, exists: !!old, state };
        });
        return send(res, 200, { ok: true, rules: list });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === "/api/txt-toc-rules/import" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        let rules = parseTxtTocRulesText(text);
        if (Array.isArray(body.ids)) {
          const want = new Set(body.ids.map(String));
          rules = rules.filter((r) => want.has(String(r.id)));
        }
        const list = config.online.txtTocRules;
        let added = 0, updated = 0;
        for (const r of rules) {
          const i = list.findIndex((x) => String(x.id) === String(r.id));
          if (i >= 0) { r.order = Number.isFinite(Number(list[i].order)) ? list[i].order : r.order; list[i] = r; updated++; }
          else {
            if (!Number.isFinite(Number(r.order))) {
              r.order = list.reduce((mx, x) => Math.max(mx, Number.isFinite(Number(x.order)) ? Number(x.order) : 0), 0) + 1;
            }
            list.push(r); added++;
          }
        }
        invalidateFileCache();
        saveConfig();
        return send(res, 200, { ok: true, added, updated, rules: sortedTxtTocRules() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p.startsWith("/fonts/")) {
      const rel = decodeURIComponent(p.slice("/fonts/".length)).replace(/\\/g, "/");
      const abs = path.join(FONT_DIR, path.basename(rel));
      try {
        const buf = await fsp.readFile(abs);
        return send(res, 200, buf, FONT_MIME[path.extname(abs).toLowerCase()] || "font/ttf");
      } catch { return send(res, 404, { error: "字体不存在" }); }
    }

    /** 优雅关闭：Windows taskkill /f 不走 SIGTERM，.bat 改为先调这个接口再兜底强杀 */
    if (p === "/api/shutdown" && req.method === "POST") {
      const origin = req.headers.origin || "";
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
        return send(res, 403, { error: "禁止跨站关闭服务" });
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }), () => setTimeout(shutdown, 100));
      return;
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "未知接口" });
    return await serveStatic(res, p);
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // PORT=0 时由系统分配，这里回填真实端口，后续所有 URL 都用它
  const addr = server.address();
  activePort = (addr && typeof addr === "object" && addr.port) ? addr.port : PORT;
  console.log(`阅读器已启动: http://127.0.0.1:${activePort}`);
  if (activePort !== 7789) {
    console.log(`（当前端口 ${activePort}；改端口：命令行加 --port 8080，或在程序同级放 port.txt 写一个数字）`);
  }
});

/* 端口被占用时的处理（与 Reader 项目同一套语义）：
   · 用户没显式指定端口（重复双击 exe）→ 说明已有一个实例在跑，
     提示后退出，不要起第二个实例；
   · 用户显式指定了端口但被占用 → 自动往后找空闲端口，
     避免「想换端口却恰好被占用」直接失败。 */
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    if (PORT_EXPLICIT) {
      if (tryListenNextPort()) return;
      console.error(`端口 ${activePort} 及其后续端口都被占用，请换一个（--port 9000）`);
      setTimeout(() => process.exit(1), 1500);
      return;
    }
    console.log(`阅读器已在运行: http://127.0.0.1:${activePort}/`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error("启动失败: " + (e && e.message));
  process.exit(1);
});

/**
 * 端口被占用时向后找下一个可用端口（最多试 20 个）。
 * 只在用户显式指定端口时调用，避免「双击两次却起了两个实例」。
 */
let portRetry = 0;
function tryListenNextPort() {
  if (portRetry >= 20) {
    console.error("连续 20 个端口都被占用，请手动指定一个空闲端口（--port 9000）");
    return false;
  }
  portRetry++;
  const next = activePort + 1;
  if (next > 65535) return false;
  console.log(`端口 ${activePort} 被占用，改用 ${next} …`);
  activePort = next;
  server.removeAllListeners("error");
  server.once("error", (e) => {
    if (e && e.code === "EADDRINUSE") {
      if (!tryListenNextPort()) process.exit(1);
      return;
    }
    console.error("启动失败: " + (e && e.message));
    process.exit(1);
  });
  server.listen(activePort, "127.0.0.1");
  return true;
}

function shutdown() {
  flushConfigNow();
  try { server.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);   // Windows 关闭控制台窗口
process.on("SIGBREAK", shutdown); // Windows Ctrl+Break
