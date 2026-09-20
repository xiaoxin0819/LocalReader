/* 真实大书标题：批量路径 vs 逐条路径，必须逐条完全一致。

   需要一本真实 txt 才能跑（大文件更能暴露批处理的边界问题）。
   书名通过参数或环境变量指定，默认取书架第一本：
     node tools/regress/verify-realbook-titles.mjs "书名关键字"
     PROBE_BOOK=书名关键字 node tools/regress/verify-realbook-titles.mjs

   书架路径取自 reader.config.json 的 shelves[0].path（本机个人配置，不进仓库）。 */
import fs from "node:fs";
import path from "node:path";
import { decodeBuffer, analyzeText } from "../../parse-core.mjs";
import { pickTocRule, analyzeByTocRule } from "../../src/txt-toc-rules.mjs";
import { replaceWithRule, replaceManyWithRule } from "../../src/replace-engine.mjs";

const cfg = JSON.parse(fs.readFileSync(new URL("../../reader.config.json", import.meta.url), "utf8"));
const shelf = cfg.shelves[0];
if (!shelf || !shelf.path) {
  console.error("reader.config.json 里没有书架，先在界面导入一个 txt 文件夹");
  process.exit(1);
}
const keyword = process.argv[2] || process.env.PROBE_BOOK || "";
const files = fs.readdirSync(shelf.path).filter((f) => f.endsWith(".txt"));
// 给了关键字就按关键字挑，否则取最大的那个（大文件更能暴露边界问题）
const file = keyword
  ? files.find((f) => f.includes(keyword))
  : files.map((f) => ({ f, size: fs.statSync(path.join(shelf.path, f)).size }))
    .sort((a, b) => b.size - a.size)[0]?.f;
if (!file) {
  console.error(keyword ? `书架里找不到含「${keyword}」的 txt` : "书架里没有 txt 文件");
  process.exit(1);
}
console.log("测试书:", file);
const abs = path.join(shelf.path, file);
const { text } = decodeBuffer(fs.readFileSync(abs));
const rules = (cfg.online.txtTocRules || []).filter((r) => r && r.enable === true);
const rule = pickTocRule(text, rules);
const out = analyzeByTocRule(text, rule, { name: "", author: "" });
const titles = out.chapters.map((c) => String(c.title == null ? "" : c.title).replace(/[\r\n]/g, ""));
console.log("标题数:", titles.length);

const tr = (cfg.online.replaceRules || []).filter((r) => r.isEnabled !== false && r.scopeTitle === true && r.pattern);
console.log("标题规则:", tr.map((r) => r.name).join(", "));

for (const r of tr) {
  const opt = { name: r.name, pattern: r.pattern, replacement: r.replacement, isRegex: r.isRegex !== false, timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000 };
  const t0 = Date.now();
  const many = replaceManyWithRule({ ...opt, texts: titles });
  const tMany = Date.now() - t0;
  const t1 = Date.now();
  const one = titles.map((t) => { try { const v = replaceWithRule({ ...opt, text: t }); return v == null ? null : String(v); } catch { return null; } });
  const tOne = Date.now() - t1;
  let diff = 0;
  for (let i = 0; i < titles.length; i++) {
    if (one[i] !== many[i]) { diff++; if (diff <= 3) console.log("  DIFF@" + i, JSON.stringify(titles[i]), "single=" + JSON.stringify(one[i]), "many=" + JSON.stringify(many[i])); }
  }
  console.log(`  ${r.name}: 批量 ${tMany}ms / 逐条 ${tOne}ms / 差异 ${diff}  ${diff === 0 ? "PASS" : "FAIL"}`);
}
