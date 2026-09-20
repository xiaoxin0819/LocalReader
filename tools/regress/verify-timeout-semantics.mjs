import { replaceWithRule, replaceManyWithRule, RegexTimeoutError } from "../../src/replace-engine.mjs";

// 病态规则（每条死循环）：整批超时 → 退回逐条 → 逐条超时 → 抛 RegexTimeoutError
// 对齐 legado BookChapter.getDisplayTitle：超时异常由调用方禁用该规则。
const big = Array.from({ length: 600 }, (_, i) => "第" + i + "章 标题");
const t0 = Date.now();
let threw = null;
try {
  replaceManyWithRule({ name: "slow", texts: big, pattern: "^.*$", replacement: "@js:(function(){var x=0;while(true){x++;}})()", isRegex: true, timeout: 300 });
} catch (e) { threw = e; }
const ms = Date.now() - t0;
const ok = threw instanceof RegexTimeoutError;
console.log((ok ? "PASS  " : "FAIL  ") + "病态规则抛 RegexTimeoutError  耗时 " + ms + "ms  实际=" + (threw ? threw.name : "无"));
process.exit(ok ? 0 : 1);
