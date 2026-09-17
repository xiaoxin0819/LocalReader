/* 统一章节.mjs —— 把 txt 的章节标题统一成「第N章 名称」
   node 统一章节.mjs <目录|文件...> [--apply] [--out=报告.jsonl] [--insert] [--quiet]
*/
import fs from "node:fs";
import path from "node:path";
import { decodeBuffer, analyzeText } from "./parse-core.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const INSERT = argv.includes("--insert");
const QUIET = argv.includes("--quiet");
const outArg = argv.find((a) => a.startsWith("--out="));
const OUT = outArg ? outArg.slice(6) : "";
const listArg = argv.find((a) => a.startsWith("--list="));
const targets = argv.filter((a) => !a.startsWith("--"));
if (!targets.length && !listArg) { console.log("用法: node 统一章节.mjs <目录|文件...> [--apply] [--out=报告.jsonl] [--insert]"); process.exit(1); }

function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (/\.(txt|md)$/i.test(p)) out.push(p); return; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("__")) continue;
    const q = path.join(p, e.name);
    if (e.isDirectory()) collect(q, out);
    else if (/\.(txt|md)$/i.test(e.name)) out.push(q);
  }
}
const files = [];
if (listArg) { for (const l of fs.readFileSync(listArg.slice(7), "utf8").split(/\r?\n/)) if (l.trim()) files.push(l.trim()); }
else for (const t of targets) collect(path.resolve(t), files);
files.sort();

const fmt = (t) => /^第\d+章(?:\s|$)/.test(t) ? "标准"
  : /^【\s*\d+\s*】/.test(t) ? "方括号数字"
  : /^第\s*[0-9]+\s*[章节回话集篇部]/.test(t) ? "第X章·阿拉伯"
  : /^第\s*[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖]+\s*[章节回话集篇部]/.test(t) ? "第X章·中文"
  : /^[Cc]hapter|^Turn/i.test(t) ? "Chapter/Turn"
  : /^\d{1,5}\s*[\s:：.。、,，\-—]/.test(t) ? "纯数字"
  : /^[零一二两三四五六七八九十百千万]{1,7}[\s、.．:：]/.test(t) ? "中文数字"
  : "其他";

const rows = [];
let nOk = 0, nMod = 0, nFell = 0, nNoHead = 0, nEnc = 0, nFail = 0, nEmpty = 0, nZero = 0;
let titlesChanged = 0, titlesTotal = 0, bytesWritten = 0;

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { nFail++; continue; }
  if (!buf.length) { nEmpty++; continue; }
  let dec, a;
  try { dec = decodeBuffer(buf); a = analyzeText(dec.text, path.basename(f, path.extname(f))); }
  catch (e) { nFail++; rows.push({ f, kind: "解析失败", err: e.message }); continue; }

  const lines = a.lines.slice();
  let changed = 0, inserted = 0;
  const kinds = new Set();
  a.chapters.forEach((c) => {
    titlesTotal++;
    if (c.noHead) { nNoHead++; if (INSERT) { lines[c.start] = c.label + "\n" + lines[c.start]; inserted++; } return; }
    const old = lines[c.start];
    kinds.add(fmt(old.trim()));
    if (old.trim() !== c.label) { lines[c.start] = c.label; changed++; }
  });
  if (a.fellBack) nFell++;
  if (!a.chapters.length) nZero++;
  titlesChanged += changed;

  const needWrite = changed > 0 || inserted > 0;
  if (needWrite) {
    nMod++;
    if (dec.encoding === "gb18030") nEnc++;
    if (APPLY && !a.fellBack) {
      const out = lines.join("\r\n");
      fs.writeFileSync(f, Buffer.from(out, "utf8"));
      bytesWritten += Buffer.byteLength(out);
    }
    rows.push({ f: path.relative(process.cwd(), f), kind: a.fellBack ? "兜底·未改" : [...kinds].join("+"), chapters: a.chapters.length, changed, inserted, enc: dec.encoding });
  } else nOk++;

  if (!QUIET && files.length > 500 && (nOk + nMod) % 500 === 0) console.log(" ...", nOk + nMod, "/", files.length);
}

if (OUT) fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");

console.log("扫描", files.length, "本 | 需改", nMod, "本 | 已标准", nOk, "本 | 零章", nZero, "| 空文件", nEmpty, "| 失败", nFail);
console.log("标题总数", titlesTotal, "| 需改写", titlesChanged);
console.log("兜底书", nFell, "| 无标题行章节", nNoHead, "| gb18030 转码", nEnc);
if (APPLY) console.log("已写入", (bytesWritten / 1024 / 1024 / 1024).toFixed(2), "GB（UTF-8 / CRLF）");
else console.log("（体检模式，未修改任何文件）");
