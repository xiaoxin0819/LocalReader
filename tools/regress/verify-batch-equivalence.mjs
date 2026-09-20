import fs from "node:fs";
import { replaceWithRule, replaceManyWithRule } from "../../src/replace-engine.mjs";

// 用 import.meta.url 定位，而不是相对 cwd —— 从任意目录运行都能找到配置
const cfg = JSON.parse(fs.readFileSync(new URL("../../reader.config.json", import.meta.url), "utf8"));
const rules = (cfg.online.replaceRules || []).filter((r) => r.isEnabled !== false && r.pattern);
const titles = [];
for (let i = 1; i <= 700; i++) titles.push("第" + i + "章 测试标题" + i);
titles.push("序章");
titles.push("001. 第一章 开始");
titles.push("第001章");
titles.push("正文标题。带句号");
titles.push("");
titles.push("普通文字");

let bad = 0, checked = 0;
for (const r of rules) {
  const one = titles.map((t) => {
    try {
      const v = replaceWithRule({ name: r.name, text: t, pattern: r.pattern, replacement: r.replacement, isRegex: r.isRegex !== false, timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000 });
      return v == null ? null : String(v);
    } catch { return null; }
  });
  const many = replaceManyWithRule({ name: r.name, texts: titles, pattern: r.pattern, replacement: r.replacement, isRegex: r.isRegex !== false, timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000 });
  for (let i = 0; i < titles.length; i++) {
    checked++;
    const a = one[i], b = many[i];
    const same = a === b;
    if (!same) { bad++; if (bad <= 10) console.log("DIFF rule=" + r.id + " title=" + JSON.stringify(titles[i]) + "\n  single=" + JSON.stringify(a) + "\n  many  =" + JSON.stringify(b)); }
  }
}
console.log("checked=" + checked + " diffs=" + bad);
console.log(bad === 0 ? "PASS: 批量与逐条完全一致" : "FAIL");
