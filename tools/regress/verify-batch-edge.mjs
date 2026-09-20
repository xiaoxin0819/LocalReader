import { replaceWithRule, replaceManyWithRule, RegexTimeoutError } from "../../src/replace-engine.mjs";

function cmp(label, o, texts) {
  const one = texts.map((t) => { try { const v = replaceWithRule({ ...o, text: t }); return v == null ? null : String(v); } catch { return null; } });
  const many = replaceManyWithRule({ ...o, texts });
  let bad = 0;
  for (let i = 0; i < texts.length; i++) if (one[i] !== many[i]) { bad++; console.log("  DIFF", label, JSON.stringify(texts[i]), JSON.stringify(one[i]), JSON.stringify(many[i])); }
  console.log((bad === 0 ? "PASS  " : "FAIL  ") + label + "  n=" + texts.length);
  return bad;
}

const texts = ["a1b2c3", "x", "", "第12章 标题", "1. 前缀 内容", "no digits"];
let bad = 0;

// 捕获组 $1 / 命名组 / $$ / 反斜杠
bad += cmp("capture $1", { name: "g1", pattern: "(\\d+)", replacement: "[$1]", isRegex: true, timeout: 3000 }, texts);
bad += cmp("named group", { name: "g2", pattern: "(?<num>\\d+)", replacement: "<${num}>", isRegex: true, timeout: 3000 }, texts);
bad += cmp("dollar literal", { name: "g3", pattern: "\\d", replacement: "$$", isRegex: true, timeout: 3000 }, texts);
bad += cmp("backslash", { name: "g4", pattern: "\\d", replacement: "\\n", isRegex: true, timeout: 3000 }, texts);

// @js: 各种返回
bad += cmp("js return result", { name: "j1", pattern: "(\\d+)", replacement: "@js:result", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js return upper", { name: "j2", pattern: "(\\d+)", replacement: "@js:String(result).toUpperCase()", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js return null", { name: "j3", pattern: "(\\d+)", replacement: "@js:null", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js return undefined", { name: "j4", pattern: "(\\d+)", replacement: "@js:void 0", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js completion value", { name: "j5", pattern: "(\\d+)", replacement: "@js:result + '!'", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js throw", { name: "j6", pattern: "(\\d+)", replacement: "@js:throw new Error('boom')", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js empty match", { name: "j7", pattern: "x*", replacement: "@js:'<' + result + '>'", isRegex: true, timeout: 3000 }, ["axb", "xxx", ""]);
bad += cmp("js uses chapter", { name: "j8", pattern: "(\\d+)", replacement: "@js:(chapter && chapter.title) ? chapter.title : result", isRegex: true, timeout: 3000 }, texts);

// java.put 走逐条路径，必须与单条一致
bad += cmp("js java.put", { name: "j9", pattern: "(\\d+)", replacement: "@js:java.put('k', result) + java.get('k')", isRegex: true, timeout: 3000 }, texts);
bad += cmp("js java.log", { name: "j10", pattern: "(\\d+)", replacement: "@js:java.logType(result)", isRegex: true, timeout: 3000 }, texts);

// 字面量
bad += cmp("literal replace", { name: "l1", pattern: "1", replacement: "@js:result", isRegex: false, timeout: 3000 }, texts);

// 大块 + 死循环超时 → 抛 RegexTimeoutError（对齐 legado：由调用方禁用该规则）
const big = Array.from({ length: 600 }, (_, i) => "第" + i + "章 标题");
const t0 = Date.now();
let timeoutErr = null;
try {
  replaceManyWithRule({ name: "slow", texts: big, pattern: "^.*$", replacement: "@js:(function(){var x=0;while(true){x++;}})()", isRegex: true, timeout: 300 });
} catch (e) { timeoutErr = e; }
const timeoutOk = timeoutErr instanceof RegexTimeoutError;
if (!timeoutOk) bad++;
console.log((timeoutOk ? "PASS  " : "FAIL  ") + "病态规则抛 RegexTimeoutError  " + (Date.now() - t0) + "ms  实际=" + (timeoutErr ? timeoutErr.name : "无"));

console.log(bad === 0 ? "\nALL PASS" : "\n" + bad + " FAILURES");
