/* 替换净化 / TXT 目录规则面板（本地阅读器）
 * 逻辑取自 Reader/public/online.js，已剥离书源组、在线目录刷新、在线正文等在线依赖，
 * 只保留：规则 CRUD / 启停 / 排序 / 导入预览 / 测试替换，以及规则变更后本地正文与目录重渲染。
 */

/* ============================================================
 *  需求 C2：确认框居中
 *  原来用原生 confirm()，弹在浏览器顶部，与阅读器 UI 不协调。
 *  legado 的 AlertDialog 是屏幕居中的 Material 对话框，这里等价还原。
 * ============================================================ */

function askConfirm(msg, okText = "确定", cancelText = "取消") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    const box = document.createElement("div");
    box.className = "ask-box";
    const m = document.createElement("div");
    m.className = "ask-msg";
    m.textContent = msg;
    const foot = document.createElement("div");
    foot.className = "ask-foot";
    const no = document.createElement("button");
    no.className = "ghost-btn";
    no.textContent = cancelText;
    const ok = document.createElement("button");
    ok.className = "ask-ok";
    ok.textContent = okText;
    foot.appendChild(no); foot.appendChild(ok);
    box.appendChild(m); box.appendChild(foot);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    function onKey(e) {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    }
    ok.onclick = () => done(true);
    no.onclick = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

/* ============================================================
 *  站内输入 / 文本查看弹窗（本轮补齐）
 *  之前这里到处是原生 prompt()/alert()：弹在浏览器顶部、样式与阅读器割裂，
 *  而且 prompt 是阻塞式的，脚本只能停在原地。legado 全部用 AlertDialog：
 *    · 单个输入  → alert { DialogEditTextBinding }         dialog_edit_text.xml
 *    · 多个输入  → alert { DialogMultipleEditTextBinding } dialog_multiple_edit_text.xml
 *    · 只读长文  → TextDialog                              dialog_text_view.xml
 *  下面三个函数就是这三者的等价物，样式沿用本项目的 .ask-modal / .ask-box。
 * ============================================================ */

/**
 * 多字段输入（legado dialog_multiple_edit_text.xml：N 个 TextInputLayout 竖排）。
 * @param {string} title 标题
 * @param {Array<{key:string,label:string,value?:string,placeholder?:string,area?:boolean,check?:{label:string,checked:boolean}}>} fields
 * @returns {Promise<Object|null>} 确认 → { 字段key: 值, __check: {key:bool} }；取消 → null
 */
function askFields(title, fields, opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    wrap.innerHTML = '<div class="ask-box ask-form">'
      + '<div class="ask-title"></div><div class="ask-fields"></div>'
      + '<div class="ask-foot"><button class="ghost-btn ask-no">取消</button>'
      + '<button class="ask-ok ask-yes">确定</button></div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector(".ask-title").textContent = title || "";
    const box = wrap.querySelector(".ask-fields");
    const inputs = [];
    const checks = [];
    for (const f of fields || []) {
      const row = document.createElement("div");
      row.className = "ask-field";
      // 纯复选框行（label 为空白、只带 check）在 legado 里是独立的 CheckBox 控件
      // （activity_replace_edit.xml 的 cb_use_regex 等），没有配套 EditText。
      // 之前这里无条件渲染输入框，于是「使用正则表达式」下面多出一个空文本框。
      const checkOnly = !!f.check && !String(f.label == null ? "" : f.label).trim();
      if (!checkOnly) {
        const lab = document.createElement("div");
        lab.className = "ask-lab";
        lab.textContent = f.label || f.key || "";
        row.appendChild(lab);
        let el;
        if (f.area) {
          el = document.createElement("textarea");
          el.className = "ask-area";
          if (f.rows) el.rows = f.rows;
        } else {
          el = document.createElement("input");
          el.className = "ask-input";
          el.type = f.type || "text";
        }
        el.value = f.value == null ? "" : String(f.value);
        if (f.placeholder) el.placeholder = f.placeholder;
        row.appendChild(el);
        inputs.push({ f, el });
      }
      if (f.check) {
        const cl = document.createElement("label");
        cl.className = "ask-lab imp-row";
        cl.innerHTML = '<input type="checkbox"><span></span>';
        cl.querySelector("span").textContent = f.check.label || "";
        const cb = cl.querySelector("input");
        cb.checked = f.check.checked !== false;
        checks.push({ f, cb });
        row.appendChild(cl);
      }
      box.appendChild(row);
    }
    const done = (v) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const collect = () => {
      const out = {};
      for (const { f, el } of inputs) out[f.key] = el.value;
      for (const { f, cb } of checks) out["__" + f.key] = cb.checked;
      return out;
    };
    function onKey(e) {
      // textarea 里回车是换行，不能当确认
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") done(collect());
    }
    document.addEventListener("keydown", onKey);
    // legado 编辑页菜单里的「拷贝规则 / 粘贴规则」以底部附加按钮的形式塞进来
    const o = opts || {};
    if (Array.isArray(o.footExtra)) {
      for (const x of o.footExtra) {
        const eb = document.createElement("button");
        eb.className = "ghost-btn";
        eb.textContent = x.text;
        eb.onclick = () => x.run({
          values: collect,
          set: (k, v) => {
            const h = inputs.find((a) => a.f.key === k);
            if (h) h.el.value = v == null ? "" : String(v);
            const c = checks.find((a) => a.f.key === k);
            if (c) c.cb.checked = !!v;
          },
        });
        wrap.querySelector(".ask-foot").insertBefore(eb, wrap.querySelector(".ask-no"));
      }
    }
    wrap.querySelector(".ask-no").onclick = () => done(null);
    wrap.querySelector(".ask-yes").onclick = () => done(collect());
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    if (inputs.length) { inputs[0].el.focus(); inputs[0].el.select && inputs[0].el.select(); }
  });
}

/** 单字段输入（legado dialog_edit_text.xml）。返回字符串；取消返回 null。 */
async function askPrompt(title, label, value, opts) {
  const o = opts || {};
  const r = await askFields(title, [{ key: "v", label, value, area: o.area, rows: o.rows, placeholder: o.placeholder }]);
  return r === null ? null : r.v;
}

/**
 * 只读文本窗（legado TextDialog / dialog_text_view.xml：Toolbar + 可滚动 TextView）。
 * @param {string} title 标题
 * @param {string} content 正文
 * @param {object} [opts] { copy: boolean } 是否给「复制」按钮
 */
function askText(title, content, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    wrap.innerHTML = '<div class="txt-box">'
      + '<div class="txt-head"><span class="txt-title"></span>'
      + '<button class="icon-btn txt-x" title="关闭">\u2715</button></div>'
      + '<pre class="txt-body"></pre>'
      + '<div class="txt-foot"><button class="ghost-btn txt-copy">复制</button>'
      + '<button class="primary-btn txt-ok">关闭</button></div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector(".txt-title").textContent = title || "";
    // legado TextDialog 对超长文本会截断（32KB），这里同样保护一下 DOM
    const s = String(content == null ? "" : content);
    wrap.querySelector(".txt-body").textContent = s.length > 200000 ? (s.slice(0, 200000) + "\n\n…（内容过长，已截断显示）") : s;
    if (o.copy === false) wrap.querySelector(".txt-copy").remove();
    const done = () => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(true); };
    function onKey(e) { if (e.key === "Escape" || e.key === "Enter") done(); }
    document.addEventListener("keydown", onKey);
    wrap.querySelector(".txt-x").onclick = done;
    wrap.querySelector(".txt-ok").onclick = done;
    const cp = wrap.querySelector(".txt-copy");
    if (cp) cp.onclick = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => toast("已复制"), () => toast("复制失败"));
    };
    wrap.onclick = (e) => { if (e.target === wrap) done(); };
    wrap.querySelector(".txt-ok").focus();
  });
}


/* ============================================================
 *  替换净化（legado ui/replace/ReplaceRuleActivity + ReplaceRuleAdapter）
 *  · 顶部搜索框 = SearchView：支持「已启用 / 已禁用 / 未分组 / group:xxx」四种前缀，
 *    其余按 ReplaceRuleDao.flowSearch（group like OR name like）过滤。
 *  · 列表项 = item_replace_rule.xml：[checkbox 名称(分组)] [启用开关] [编辑] [⋮]
 *    ⋮ = menu/replace_rule_item.xml：置顶(to_top) / 置底(to_bottom) / 删除(delete)
 *  · 底部 SelectActionBar 只保留「全选 / 反选」两个批量按钮（2026-09-19 用户指定）：
 *    全选 = 一键启用当前可见规则（全部已启用时变「取消全选」→ 一键停用），反选 = 已启用的停用、未启用的启用
 *    原来的启用/禁用/置顶/置底/导出/删除批量按钮全部删除，行内 ⋮ 菜单仍保留置顶/置底/删除
 *  · 编辑 = ReplaceEditActivity（activity_replace_edit.xml 字段顺序），菜单里带
 *    拷贝规则 / 粘贴规则（replace_edit.xml）。
 * ============================================================ */

let replaceRules = [];
let replaceGroups = [];
let replaceFilter = "";
let replaceOpen = false;
let txtTocRules = [];
let txtTocFilter = "";
let replaceTab = "replace";

const RP_I18N = {
  enabled: "已启用", disabled: "已禁用", noGroup: "未分组",
  all: "全选", cancelAll: "取消全选", delete: "删除", edit: "编辑",
  toTop: "置顶", toBottom: "置底", copyRule: "拷贝规则", pasteRule: "粘贴规则",
};

async function openReplace() {
  $("panelReplace").classList.remove("hidden");
  replaceOpen = true;
  // 本地阅读器：替换净化与 TXT 目录规则两个 Tab 都适用于本地 txt。
  activateReplaceTab(replaceTab || "replace");
  await Promise.all([reloadReplaceRules(), reloadTxtTocRules()]);
}

function activateReplaceTab(tab) {
  replaceTab = tab === "txtToc" ? "txtToc" : "replace";
  const isToc = replaceTab === "txtToc";
  $("replacePane")?.classList.toggle("hidden", isToc);
  $("txtTocPane")?.classList.toggle("hidden", !isToc);
  $("replacePanelTitle").textContent = isToc ? "TXT 目录规则" : "替换净化";
  document.querySelectorAll("#replaceTabs .rt-tab").forEach((b) => b.classList.toggle("active", b.dataset.rtab === replaceTab));
  if (isToc) reloadTxtTocRules().catch(() => {});
  else reloadReplaceRules().catch(() => {});
}

/**
 * 替换净化改动后让正文按新规则重渲染。
 * 后端 /api/online/content 是「抓原始正文 → 实时跑净化」，所以规则改动只需失效前端
 * chapterCache 再读一次即可恢复原样；后端 contentCache 存的是未净化的原文，不受影响。
 */
function localScrollRatio() {
  const el = $("content");
  return el && el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
}

function invalidateChapterRender() {
  chapterCache.clear();
  if (typeof localBookDataCache !== "undefined") localBookDataCache.clear();
  // 本地：替换净化同时作用于正文与标题（对齐 legado ReadBook / BookChapter.getDisplayTitle），
  // 规则变动后重读 /api/book 与当前章即可；noCache 保证不吃旧目录缓存。
  const lb = state.book;
  if (lb && lb.rel) {
    const keepIdx = state.chapterIdx;
    const keepRatio = localScrollRatio();
    openBook({ rel: lb.rel, name: lb.name || lb.title || "", mtime: lb.mtime, size: lb.size },
      { keepChapter: false, noCache: true })
      .then(() => gotoChapter(keepIdx, keepRatio))
      .catch(() => {});
  }
}

async function reloadReplaceRules(touchContent) {
  const [r, g] = await Promise.all([
    api("/api/replace-rules").catch(() => ({ rules: [] })),
    api("/api/replace-rules/groups").catch(() => ({ groups: [] })),
  ]);
  replaceRules = Array.isArray(r.rules) ? r.rules : [];
  replaceGroups = Array.isArray(g.groups) ? g.groups : [];
  renderReplaceRules();
  if (touchContent) invalidateChapterRender();
}

/** 数字标题两条内置规则互斥（与 server.mjs NUMERIC_TITLE_RULE_IDS 对应） */
const NUMERIC_TITLE_IDS = ["builtin-netclean-0", "builtin-netclean-1"];

function replaceDisplayName(r) {
  const g = r.group == null ? "" : String(r.group);
  return g.trim() ? r.name + " (" + g + ")" : (r.name || "");
}

/** 复刻 ReplaceRuleActivity.observeReplaceRuleData 的六路分支 */
function replaceFiltered() {
  const k = (replaceFilter || "").trim();
  const list = replaceRules.slice();
  if (!k) return list;
  if (k === RP_I18N.enabled) return list.filter((r) => r.isEnabled !== false);
  if (k === RP_I18N.disabled) return list.filter((r) => r.isEnabled === false);
  if (k === RP_I18N.noGroup) return list.filter((r) => !String(r.group == null ? "" : r.group).trim()
    || String(r.group).trim().includes(RP_I18N.noGroup));
  if (k.startsWith("group:")) {
    const key = k.slice("group:".length);
    return list.filter((r) => String(r.group == null ? "" : r.group).includes(key));
  }
  const low = k.toLowerCase();
  return list.filter((r) => String(r.group == null ? "" : r.group).toLowerCase().includes(low)
    || String(r.name || "").toLowerCase().includes(low));
}

/** 通用小浮层菜单（复用 .bk-menu 样式），items = [[文字, 回调, 是否危险]] */
function popupMenu(x, y, items) {
  document.getElementById("popMenu")?.remove();
  const menu = document.createElement("div");
  menu.className = "bk-menu";
  menu.id = "popMenu";
  menu.innerHTML = items.map(([t], i) => '<button class="bk-menu-item' + (items[i][2] ? " danger" : "")
    + '" data-i="' + i + '">' + esc(t) + "</button>").join("");
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - 150) + "px";
  menu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 12) + "px";
  menu.querySelectorAll(".bk-menu-item").forEach((el) => {
    el.onclick = () => { const f = items[Number(el.dataset.i)][1]; menu.remove(); f(); };
  });
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

function renderReplaceRules() {
  const box = $("replaceList");
  const list = replaceFiltered();
  $("replaceStat").textContent = replaceRules.length
    ? `${replaceRules.length} 条（启用 ${replaceRules.filter((x) => x.isEnabled !== false).length}）`
      + (replaceFilter.trim() ? ` · 筛选出 ${list.length}` : "")
    : "";
  if (!list.length) {
    box.innerHTML = '<div class="hint">' + (replaceRules.length
      ? "没有匹配的规则" : "还没有替换规则。点上方「新建替换」添加，或「本地导入 / 网络导入」导入规则集") + "</div>";
    renderReplaceSelBar();
    return;
  }
  box.innerHTML = list.map((r) => {
    const on = r.isEnabled !== false;
    const sub = "替换内容 " + esc(String(r.pattern).slice(0, 40))
      + " → " + esc(String(r.replacement == null ? "" : r.replacement).slice(0, 20))
      + (r.isRegex === false ? " · 纯文本" : " · 正则")
      + (r.scopeTitle === true ? " · 标题" : "")
      + (r.scopeContent !== false ? " · 正文" : "")
      + (String(r.scope || "").trim() ? " · 范围:" + esc(String(r.scope).slice(0, 20)) : "")
      + (String(r.excludeScope || "").trim() ? " · 排除:" + esc(String(r.excludeScope).slice(0, 20)) : "");
    return '<div class="src-row rp-row' + (on ? "" : " off") + '" data-id="' + esc(r.id) + '">'
      + '<label class="rp-check" title="勾选启用这条净化规则"><input type="checkbox" data-act="toggle"' + (on ? " checked" : "") + "></label>"
      + '<div class="src-info"><div class="src-name">' + esc(replaceDisplayName(r))
      + (r.builtin ? '<span class="rp-builtin">内置</span>' : '')
      + (NUMERIC_TITLE_IDS.includes(String(r.id)) ? '<span class="rp-builtin rp-xor" title="数字标题两条规则互斥：开启其中一条会自动关闭另一条">二选一</span>' : '')
      + "</div>"
      + '<div class="src-sub">' + sub + "</div></div>"
      + '<button class="mini-btn rp-ico" data-act="edit" title="编辑">✎</button>'
      + '<button class="mini-btn rp-ico" data-act="menu" title="更多">⋮</button>'
      + "</div>";
  }).join("");
  box.querySelectorAll(".rp-row").forEach((row) => {
    const id = row.dataset.id;
    const rule = replaceRules.find((x) => x.id === id);
    row.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "toggle") {
        el.onchange = async () => {
          const res = await api("/api/replace-rules/toggle", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [id], enabled: el.checked }),
          }).catch((e) => ({ error: e.message }));
          if (res && res.error) { toast("保存失败：" + res.error); el.checked = !el.checked; return; }
          const autoOff = (res && Array.isArray(res.mutexDisabled)) ? res.mutexDisabled : [];
          if (autoOff.length) {
            toast(`「${autoOff[0].name}」已自动关闭（两条数字标题规则互斥，只能启用一条）`);
            await reloadReplaceRules(true);
            return;
          }
          rule.isEnabled = el.checked;
          row.classList.toggle("off", !el.checked);
          renderReplaceSelBar();
          $("replaceStat").textContent = replaceRules.length
            ? `${replaceRules.length} 条（启用 ${replaceRules.filter((x) => x.isEnabled !== false).length}）`
            : "";
          invalidateChapterRender();
        };
      } else if (act === "edit") {
        el.onclick = () => editReplaceRule(rule);
      } else if (act === "menu") {
        el.onclick = (e) => {
          e.stopPropagation();
          const rect = el.getBoundingClientRect();
          popupMenu(rect.right - 120, rect.bottom + 4, [
            [RP_I18N.toTop, () => replaceOrder(id, "top")],
            [RP_I18N.toBottom, () => replaceOrder(id, "bottom")],
            [RP_I18N.delete, () => replaceDelete([id]), true],
          ]);
        };
      }
    });
  });
  renderReplaceSelBar();
}

/**
 * 底部栏（2026-09-19 用户指定只留两个按钮）：
 *   [全选 (已启用/可见)]  全部已启用时按钮变「取消全选」，点一下即停用全部可见规则
 *   [反选]               可见规则里已启用的停用、未启用的启用
 * 计数与 legado SelectActionBar.upCountView 一致（已选/总数），这里对应「已启用/可见条数」。
 * 栏位常显，不再随勾选浮出。
 */
function renderReplaceSelBar() {
  const bar = $("replaceSelBar");
  if (!bar) return;
  const list = replaceFiltered();
  const on = list.filter((r) => r.isEnabled !== false).length;
  const allOn = list.length > 0 && on >= list.length;
  const allBtn = bar.querySelector('[data-sel="all"]');
  if (allBtn) allBtn.textContent = (allOn ? RP_I18N.cancelAll : RP_I18N.all) + `（${on}/${list.length}）`;
}

/** 批量开关替换规则；返回 false 表示请求失败 */
async function replaceToggleIds(ids, enabled) {
  const res = await api("/api/replace-rules/toggle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, enabled }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) { toast("操作失败：" + res.error); return false; }
  const autoOff = (res && Array.isArray(res.mutexDisabled)) ? res.mutexDisabled : [];
  if (autoOff.length) toast(`「${autoOff[0].name}」已自动关闭（两条数字标题规则互斥，只能启用一条）`);
  return true;
}

async function replaceOrder(id, action) {
  const res = await api("/api/replace-rules/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("操作失败：" + res.error);
  await reloadReplaceRules(true);
}

async function replaceDelete(ids) {
  const one = ids.length === 1 ? replaceRules.find((x) => x.id === ids[0]) : null;
  if (!(await askConfirm("是否确认删除？" + (one ? "\n" + replaceDisplayName(one) : ""), "删除"))) return;
  const res = await api("/api/replace-rules/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("删除失败：" + res.error);
  await reloadReplaceRules(true);
  toast("已删除");
}


/* ============================================================
 *  TXT 目录规则（legado TxtTocRuleActivity + TxtTocRuleAdapter）
 *  · 搜索：名称 / 示例，对应 TxtTocRuleFilter.filterByKeyword
 *  · 行：[勾选 名称] [示例] [启用开关] [编辑] [⋮ 置顶/置底/删除]
 *  · 底部 SelectActionBar 只保留「全选 / 反选」（批量启用、停用），行内 ⋮ 菜单保留置顶/置底/删除
 *  · 编辑：名称 / 正则 / 替换（JS） / 示例，对应 dialog_toc_regex_edit.xml
 * ============================================================ */
function txtTocDisplayName(r) {
  return r && r.name ? String(r.name) : "未命名规则";
}

function txtTocFiltered() {
  const k = String(txtTocFilter || "").trim().toLowerCase();
  const list = txtTocRules.slice();
  if (!k) return list;
  return list.filter((r) => String(r.name || "").toLowerCase().includes(k)
    || String(r.example || "").toLowerCase().includes(k));
}

async function reloadTxtTocRules(touchContent) {
  const r = await api("/api/txt-toc-rules").catch(() => ({ rules: [] }));
  txtTocRules = Array.isArray(r.rules) ? r.rules : [];
  renderTxtTocRules();
  if (touchContent) invalidateTocRuleRender();
}

function invalidateTocRuleRender() {
  chapterCache.clear();
  if (typeof localBookDataCache !== "undefined") localBookDataCache.clear();
  // 目录规则会改变分章结果，必须丢掉旧目录并按新规则重读。
  if (state.book) {
    openBook({ rel: state.book.rel, name: state.book.name || state.book.title || "",
      mtime: state.book.mtime, size: state.book.size },
      { keepChapter: true, noCache: true }).catch(() => {});
  }
}

function renderTxtTocRules() {
  const box = $("txtTocList");
  if (!box) return;
  const list = txtTocFiltered();
  const total = txtTocRules.length;
  const enabled = txtTocRules.filter((x) => x.enable === true).length;
  const stat = $("txtTocStat");
  if (stat) stat.textContent = total ? total + " 条（启用 " + enabled + "）" + (txtTocFilter.trim() ? " · 筛选出 " + list.length : "") : "";
  if (!list.length) {
    box.innerHTML = '<div class="hint">' + (total
      ? "没有匹配的目录规则" : "还没有 TXT 目录规则。点上方「新增」或「导入默认规则」添加") + "</div>";
    renderTxtTocSelBar();
    return;
  }
  box.innerHTML = list.map((r) => {
    const on = r.enable === true;
    const rule = String(r.rule == null ? "" : r.rule);
    const rep = String(r.replacement == null ? "" : r.replacement);
    const sub = "正则 " + esc(rule.slice(0, 52))
      + (rep ? " · 替换 " + esc(rep.slice(0, 34)) : "")
      + (r.builtin ? " · 内置" : "");
    return '<div class="src-row rp-row' + (on ? "" : " off") + '" data-id="' + esc(r.id) + '">'
      + '<label class="rp-check" title="勾选启用这条目录规则"><input type="checkbox" data-act="toggle"' + (on ? " checked" : "") + "></label>"
      + '<div class="src-info"><div class="src-name">' + esc(txtTocDisplayName(r))
      + (r.builtin ? '<span class="rp-builtin">内置</span>' : '') + "</div>"
      + '<div class="src-sub">' + sub + (r.example ? " · 示例：" + esc(String(r.example).slice(0, 44)) : "") + "</div></div>"
      + '<button class="mini-btn rp-ico" data-act="edit" title="编辑">✎</button>'
      + '<button class="mini-btn rp-ico" data-act="menu" title="更多">⋮</button>'
      + "</div>";
  }).join("");
  box.querySelectorAll(".rp-row").forEach((row) => {
    const id = String(row.dataset.id);
    const rule = txtTocRules.find((x) => String(x.id) === id);
    row.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "toggle") {
        el.onchange = async () => {
          const res = await api("/api/txt-toc-rules/toggle", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [id], enabled: el.checked }),
          }).catch((e) => ({ error: e.message }));
          if (res && res.error) { toast("保存失败：" + res.error); el.checked = !el.checked; return; }
          rule.enable = el.checked;
          row.classList.toggle("off", !el.checked);
          renderTxtTocRules();
          invalidateTocRuleRender();
        };
      } else if (act === "edit") {
        el.onclick = () => editTxtTocRule(rule);
      } else if (act === "menu") {
        el.onclick = (e) => {
          e.stopPropagation();
          const rect = el.getBoundingClientRect();
          popupMenu(rect.left - 118, rect.bottom + 3, [
            [RP_I18N.toTop, () => txtTocOrder([id], "top")],
            [RP_I18N.toBottom, () => txtTocOrder([id], "bottom")],
            [RP_I18N.delete, () => txtTocDelete([id]), true],
          ]);
        };
      }
    });
  });
  renderTxtTocSelBar();
}

/** 同 renderReplaceSelBar：底部只留「全选 / 反选」，计数 = 已启用 / 当前可见 */
function renderTxtTocSelBar() {
  const bar = $("txtTocSelBar");
  if (!bar) return;
  const list = txtTocFiltered();
  const on = list.filter((r) => r.enable === true).length;
  const allOn = list.length > 0 && on >= list.length;
  const allBtn = bar.querySelector('[data-sel="all"]');
  if (allBtn) allBtn.textContent = (allOn ? RP_I18N.cancelAll : RP_I18N.all) + "（" + on + "/" + list.length + "）";
}

/** 批量开关 TXT 目录规则；返回 false 表示请求失败 */
async function txtTocToggleIds(ids, enabled) {
  const res = await api("/api/txt-toc-rules/toggle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, enabled }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) { toast("操作失败：" + res.error); return false; }
  return true;
}

async function txtTocOrder(ids, action) {
  const res = await api("/api/txt-toc-rules/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(ids.length === 1 ? { id: ids[0], action } : { ids, action }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("操作失败：" + res.error);
  await reloadTxtTocRules(true);
}

async function txtTocDelete(ids) {
  const one = ids.length === 1 ? txtTocRules.find((x) => String(x.id) === String(ids[0])) : null;
  if (!(await askConfirm("是否确认删除？" + (one ? "\n" + txtTocDisplayName(one) : ""), "删除"))) return;
  const res = await api("/api/txt-toc-rules/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("删除失败：" + res.error);
  await reloadTxtTocRules(true);
  toast("已删除");
}

async function editTxtTocRule(rule) {
  const r = rule || {};
  const v = await askFields(r.id == null ? "新增 TXT 目录规则" : "编辑 TXT 目录规则", [
    { key: "name", label: "名称", value: r.name || "", placeholder: "例如：目录(去空白)" },
    { key: "rule", label: "正则（rule）", value: r.rule || "", area: true, rows: 5,
      placeholder: "Pattern.MULTILINE" },
    { key: "replacement", label: "替换 / JS（replacement）", value: r.replacement == null ? "" : String(r.replacement), area: true, rows: 5,
      placeholder: "可留空；支持 result、index、prevTitle、java.putVolume()" },
    { key: "example", label: "示例", value: r.example == null ? "" : String(r.example) },
  ]);
  if (v === null) return false;
  if (!String(v.name || "").trim()) { toast("名称不能为空"); return false; }
  const body = {
    id: r.id,
    name: String(v.name).trim(),
    rule: String(v.rule || ""),
    replacement: String(v.replacement == null ? "" : v.replacement),
    example: String(v.example || ""),
    serialNumber: Number.isFinite(Number(r.serialNumber)) ? Number(r.serialNumber) : undefined,
    enable: r.enable !== false,
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : undefined,
    builtin: r.builtin === true,
    builtinSource: r.builtinSource || "",
  };
  const res = await api("/api/txt-toc-rules/save", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule: body }),
  }).catch((e) => ({ error: e.message }));
  if (!res || res.error || res.ok === false) {
    toast("保存失败：" + String((res && res.error) || "未知错误"));
    return false;
  }
  await reloadTxtTocRules(true);
  return true;
}

async function txtTocPreviewImport({ text, url, from }) {
  toast("正在解析 " + (from || "") + " …");
  const r = await api("/api/txt-toc-rules/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : { text }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ok) return toast("解析失败：" + String((r && r.error) || "格式不对"));
  const list = Array.isArray(r.rules) ? r.rules : [];
  if (!list.length) return toast("格式不对");

  const wrap = document.createElement("div");
  wrap.className = "ask-modal";
  wrap.innerHTML = '<div class="imp-box">'
    + '<div class="imp-head"><span class="imp-title">导入 TXT 目录规则</span><span class="imp-stat hint"></span>'
    + '<button class="icon-btn imp-x" title="关闭">✕</button></div>'
    + '<div class="imp-tools"><button class="mini-btn imp-all">全选</button>'
    + '<button class="mini-btn imp-none">全不选</button>'
    + '<button class="mini-btn imp-new">只选新增</button></div>'
    + '<div class="imp-list"></div>'
    + '<div class="imp-foot"><button class="ghost-btn imp-cancel">取消</button>'
    + '<button class="primary-btn imp-ok">导入</button></div></div>';
  document.body.appendChild(wrap);
  const listEl = wrap.querySelector('.imp-list');
  const boxes = [];
  for (const s of list) {
    const row = document.createElement('label');
    row.className = 'imp-row' + (s.exists ? ' exists' : '');
    row.innerHTML = '<input type="checkbox" checked><span class="imp-name"></span><span class="imp-tags"></span>';
    row.querySelector('.imp-name').textContent = s.name || '未命名规则';
    row.querySelector('.imp-tags').innerHTML = '<span class="imp-tag' + (s.exists ? ' ex' : '') + '">' + esc(s.state || (s.exists ? '已有' : '新增')) + '</span>';
    row.title = String(s.rule || '');
    boxes.push({ s, cb: row.querySelector('input') });
    listEl.appendChild(row);
  }
  wrap.querySelector('.imp-stat').textContent = "新增 " + list.filter((x) => x.state === '新增').length
    + "，更新 " + list.filter((x) => x.state === '更新').length
    + "，已有 " + list.filter((x) => x.state === '已有').length;
  const setChecked = (fn) => { for (const b of boxes) b.cb.checked = fn(b.s); };
  wrap.querySelector('.imp-all').onclick = () => setChecked(() => true);
  wrap.querySelector('.imp-none').onclick = () => setChecked(() => false);
  wrap.querySelector('.imp-new').onclick = () => setChecked((x) => x.state === '新增');
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.imp-x').onclick = close;
  wrap.querySelector('.imp-cancel').onclick = close;
  wrap.querySelector('.imp-ok').onclick = async () => {
    const ids = boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
    if (!ids.length) return toast('没有勾选任何规则');
    close();
    const res = await api('/api/txt-toc-rules/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(url ? { url, ids } : { text, ids }),
    }).catch((e) => ({ error: e.message }));
    if (!res || res.error || res.ok === false) return toast('导入失败：' + String((res && res.error) || '未知错误'));
    toast("导入完成：新增 " + res.added + "，更新 " + res.updated);
    await reloadTxtTocRules(true);
  };
}

/**
 * 替换规则编辑（legado ReplaceEditActivity + activity_replace_edit.xml）。
 * 字段顺序：名称 / 分组 / 替换内容(pattern) / 使用正则(isRegex) / 替换为(replacement) /
 *   作用于标题(scopeTitle) / 作用于正文(scopeContent) / 替换范围(scope) /
 *   排除范围(excludeScope) / 超时毫秒数。
 * 菜单 append：拷贝规则 / 粘贴规则（replace_edit.xml）。
 */
async function editReplaceRule(rule) {
  const r = rule || {};
  const v = await askFields(r.id ? "编辑替换规则" : "新建替换", [
    { key: "name", label: "替换规则名称", value: r.name || "", placeholder: "replace_rule_summary" },
    { key: "group", label: "分组（可留空）", value: r.group || "", placeholder: "group" },
    { key: "pattern", label: "替换规则（pattern）", value: r.pattern || "", area: true, rows: 4,
      placeholder: "replace_rule" },
    { key: "isRegex", label: " ", value: "", check: { label: "使用正则表达式", checked: r.isRegex !== false } },
    { key: "replacement", label: "替换为（留空即删除）", value: r.replacement == null ? "" : String(r.replacement), area: true, rows: 3,
      placeholder: "replace_to" },
    { key: "scopeTitle", label: " ", value: "", check: { label: "作用于标题", checked: r.scopeTitle === true } },
    { key: "scopeContent", label: " ", value: "", check: { label: "作用于正文", checked: r.scopeContent !== false } },
    { key: "scope", label: "替换范围，选填书名或者书源 URL", value: r.scope || "", placeholder: "replace_scope" },
    { key: "excludeScope", label: "排除范围，选填书名或者书源 URL", value: r.excludeScope || "", placeholder: "replace_exclude_scope" },
    { key: "timeoutMillisecond", label: "超时毫秒数", value: String(r.timeoutMillisecond || 3000), type: "number" },
  ], {
    footExtra: [
      { text: RP_I18N.copyRule, run: (h) => {
          const body = { ...h.values(), isEnabled: r.isEnabled !== false };
          delete body.__isRegex; delete body.__scopeTitle; delete body.__scopeContent;
          const t = JSON.stringify({ ...body, isRegex: !!h.values().__isRegex,
            scopeTitle: !!h.values().__scopeTitle, scopeContent: !!h.values().__scopeContent }, null, 2);
          if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast("已复制规则"), () => toast("复制失败"));
        } },
      { text: RP_I18N.pasteRule, run: async (h) => {
          const t = await askPrompt("粘贴规则", "把规则 JSON 粘贴到这里", "");
          if (t === null || !String(t).trim()) return;
          let one;
          try { one = JSON.parse(String(t).trim()); } catch { return toast("格式不对"); }
          if (Array.isArray(one)) one = one[0];
          if (!one || typeof one !== "object") return toast("格式不对");
          const src = one.pattern != null ? one
            : { pattern: one.regex, name: one.replaceSummary, replacement: one.replacement,
                isRegex: one.isRegex, scope: one.useTo, isEnabled: one.enable };
          h.set("name", src.name || "");
          h.set("group", src.group || "");
          h.set("pattern", src.pattern || "");
          h.set("replacement", src.replacement == null ? "" : src.replacement);
          h.set("isRegex", src.isRegex !== false);
          h.set("scopeTitle", src.scopeTitle === true);
          h.set("scopeContent", src.scopeContent !== false);
          h.set("scope", src.scope || "");
          h.set("excludeScope", src.excludeScope || "");
          h.set("timeoutMillisecond", src.timeoutMillisecond || 3000);
          toast("已粘贴规则");
        } },
    ],
  });
  if (v === null) return false;
  const body = {
    id: r.id,
    name: String(v.name || "").trim() || "未命名规则",
    group: String(v.group || ""),
    pattern: String(v.pattern),
    replacement: String(v.replacement == null ? "" : v.replacement),
    isRegex: !!v.__isRegex,
    isEnabled: r.isEnabled !== false,
    scopeTitle: !!v.__scopeTitle,
    scopeContent: !!v.__scopeContent,
    scope: String(v.scope || ""),
    excludeScope: String(v.excludeScope || ""),
    timeoutMillisecond: Number(v.timeoutMillisecond) || 3000,
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : undefined,
  };
  // ReplaceRule.isValid()：pattern 空 / 正则写坏 / 以「|」结尾（转义过的 \| 除外）
  if (!body.pattern) { toast("替换规则为空或者不满足正则表达式要求"); return false; }
  if (body.isRegex) {
    try { new RegExp(body.pattern); }
    catch (e) { toast("替换规则为空或者不满足正则表达式要求：" + e.message); return false; }
    if (/\|$/.test(body.pattern) && !/\\\|$/.test(body.pattern)) {
      toast("替换规则为空或者不满足正则表达式要求（正则不能以「|」结尾）"); return false;
    }
  }
  const res = await api("/api/replace-rules/save", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule: body }),
  }).catch((e) => ({ error: e.message }));
  if (!res || res.error || res.ok === false) {
    toast("保存失败：" + String((res && (res.error || res.error)) || "未知错误"));
    return false;
  }
  await reloadReplaceRules(true);
  return true;
}

$("replaceAdd").onclick = async () => {
  if (await editReplaceRule(null)) toast("已新增替换规则");
};

$("replaceBuiltin").onclick = async () => {
  const r = await api("/api/replace-rules/builtin/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) return toast("恢复内置规则失败：" + r.error);
  await reloadReplaceRules(true);
  toast("已恢复 " + ((r && r.count) || 0) + " 条内置净化规则");
};

$("replaceFilter").oninput = (e) => {
  replaceFilter = e.target.value || "";
  renderReplaceRules();
};

/** 底部栏：全选（= 全部启用 / 全部停用）+ 反选（= 反转可见规则的启用状态） */
$("replaceSelBar").onclick = async (e) => {
  const b = e.target.closest("[data-sel]");
  if (!b) return;
  const list = replaceFiltered();
  if (!list.length) return;
  const act = b.dataset.sel;
  if (act === "all") {
    const allOn = list.every((r) => r.isEnabled !== false);
    if (await replaceToggleIds(list.map((r) => r.id), !allOn)) await reloadReplaceRules(true);
    return;
  }
  if (act === "invert") {
    const off = list.filter((r) => r.isEnabled === false).map((r) => r.id);
    const on = list.filter((r) => r.isEnabled !== false).map((r) => r.id);
    let ok = true;
    if (off.length) ok = await replaceToggleIds(off, true);
    if (ok && on.length) ok = await replaceToggleIds(on, false);
    if (ok) await reloadReplaceRules(true);
  }
};

/**
 * 测试替换 —— 对齐 ReplaceRuleController.testRule：入参 { rule, text }。
 * 编辑页里没有「测试」按钮，测试入口在管理页（拿当前正在读的这一章正文试跑）。
 */
$("txtTocAdd").onclick = async () => {
  if (await editTxtTocRule(null)) toast("已新增 TXT 目录规则");
};

$("txtTocBuiltin").onclick = async () => {
  const r = await api("/api/txt-toc-rules/builtin/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) return toast("导入默认规则失败：" + r.error);
  await reloadTxtTocRules(true);
  toast("已导入 " + ((r && r.count) || 0) + " 条默认目录规则");
};

$("txtTocFilter").oninput = (e) => {
  txtTocFilter = e.target.value || "";
  renderTxtTocRules();
};

$("txtTocImport").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,.txt";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    await txtTocPreviewImport({ text: await file.text(), from: file.name });
  };
  inp.click();
};

$("txtTocImportUrl").onclick = async () => {
  const v = await askPrompt("网络导入 TXT 目录规则", "规则订阅 / 直链地址（http/https）", "");
  if (v === null) return;
  const url = String(v || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("仅支持 http(s) 地址");
  await txtTocPreviewImport({ url, from: url });
};

/** 底部栏：全选（= 全部启用 / 全部停用）+ 反选（= 反转可见规则的启用状态） */
$("txtTocSelBar").onclick = async (e) => {
  const b = e.target.closest("[data-sel]");
  if (!b) return;
  const list = txtTocFiltered();
  if (!list.length) return;
  const act = b.dataset.sel;
  if (act === "all") {
    const allOn = list.every((r) => r.enable === true);
    if (await txtTocToggleIds(list.map((r) => String(r.id)), !allOn)) await reloadTxtTocRules(true);
    return;
  }
  if (act === "invert") {
    const off = list.filter((r) => r.enable !== true).map((r) => String(r.id));
    const on = list.filter((r) => r.enable === true).map((r) => String(r.id));
    let ok = true;
    if (off.length) ok = await txtTocToggleIds(off, true);
    if (ok && on.length) ok = await txtTocToggleIds(on, false);
    if (ok) await reloadTxtTocRules(true);
  }
};

$("replaceTabs").onclick = (e) => {
  const b = e.target.closest("[data-rtab]");
  if (b) activateReplaceTab(b.dataset.rtab);
};

$("replaceTest").onclick = async () => {
  const v = await askFields("测试替换", [
    { key: "name", label: "替换规则名称（可留空）", value: "" },
    { key: "pattern", label: "替换规则（pattern）", value: "", area: true, rows: 4 },
    { key: "isRegex", label: " ", value: "", check: { label: "使用正则表达式", checked: true } },
    { key: "replacement", label: "替换为（留空即删除）", value: "", area: true, rows: 2 },
  ]);
  if (v === null) return;
  const pattern = String(v.pattern || "");
  if (!pattern) return toast("替换规则为空或者不满足正则表达式要求");
  const cur = ($("content") && $("content").textContent) || "";
  if (!cur.trim()) return toast("先打开一本书，用当前章节正文测试");
  const rule = { name: v.name || "", pattern, replacement: String(v.replacement || ""), isRegex: !!v.__isRegex, timeoutMillisecond: 3000 };
  const r = await api("/api/replace-rules/test", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule, text: cur.slice(0, 4000) }),
  }).catch((e) => ({ error: e.message }));
  if (!r) return toast("测试失败");
  if (r.ok === false) return askText("测试失败", String(r.error || "未知错误"));
  const src = cur.slice(0, 4000);
  const out = String(r.text || "");
  await askText("替换结果（原文 " + src.length + " 字 → 结果 " + out.length + " 字）", out.slice(0, 4000));
};

/* ---------------- 替换规则导入 / 分组管理 ---------------- */

/** 导入预览（legado ImportReplaceRuleDialog + ReplaceRuleImportComparison） */
async function replacePreviewImport({ text, url, from }) {
  toast("正在解析 " + (from || "") + " …");
  const r = await api("/api/replace-rules/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : { text }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ok) return toast("解析失败：" + String((r && r.error) || "格式不对"));
  const list = Array.isArray(r.rules) ? r.rules : [];
  if (!list.length) return toast("格式不对");

  const wrap = document.createElement("div");
  wrap.className = "ask-modal";
  wrap.innerHTML = '<div class="imp-box">'
    + '<div class="imp-head"><span class="imp-title"></span><span class="imp-stat hint"></span>'
    + '<button class="icon-btn imp-x" title="关闭">\u2715</button></div>'
    + '<div class="imp-tools">'
    + '<button class="mini-btn imp-all">全选</button>'
    + '<button class="mini-btn imp-none">全不选</button>'
    + '<button class="mini-btn imp-new">只选新增</button>'
    + '<button class="mini-btn imp-group">自定义源分组</button>'
    + "</div>"
    + '<div class="imp-list"></div>'
    + '<div class="imp-foot"><button class="ghost-btn imp-cancel">取消</button>'
    + '<button class="primary-btn imp-ok">导入选中</button></div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector(".imp-title").textContent = "导入替换规则 · " + (from || "");
  wrap.querySelector(".imp-stat").textContent = `共 ${list.length} 条，新增 ${list.filter((x) => x.state === "新增").length}，更新 ${list.filter((x) => x.state === "更新").length}，已有 ${list.filter((x) => x.state === "已有").length}`;

  const boxes = [];
  const listEl = wrap.querySelector(".imp-list");
  for (const s of list) {
    const row = document.createElement("label");
    row.className = "imp-row";
    row.innerHTML = '<input type="checkbox" checked><span class="imp-name"></span><span class="imp-tags"></span>';
    row.querySelector(".imp-name").textContent = s.group ? `${s.name}(${s.group})` : (s.name || "未命名规则");
    const tags = [];
    if (s.state === "已有") tags.push('<span class="imp-tag ex">已有</span>');
    else if (s.state === "更新") tags.push('<span class="imp-tag">更新</span>');
    else tags.push('<span class="imp-tag">新增</span>');
    if (s.isRegex) tags.push('<span class="imp-tag">正则</span>');
    row.querySelector(".imp-tags").innerHTML = tags.join("");
    row.title = s.pattern;
    boxes.push({ s, cb: row.querySelector("input") });
    listEl.appendChild(row);
  }
  const setChecked = (fn) => { for (const b of boxes) b.cb.checked = fn(b.s); };
  wrap.querySelector(".imp-all").onclick = () => setChecked(() => true);
  wrap.querySelector(".imp-none").onclick = () => setChecked(() => false);
  // legado ReplaceRuleImportComparison：selectStatus = existingRules == null → 默认只勾新增
  wrap.querySelector(".imp-new").onclick = () => setChecked((s) => s.state === "新增");
  setChecked((s) => s.state === "新增" || s.state === "更新");

  let group = "", addGroup = false;
  const gBtn = wrap.querySelector(".imp-group");
  gBtn.onclick = async () => {
    const v = await askFields("自定义源分组", [
      { key: "group", label: "分组名称", value: group },
      { key: "add", label: " ", value: "", check: { label: "加入分组（不勾选=直接替换成分组）", checked: addGroup } },
    ]);
    if (v === null) return;
    group = String(v.group || "").trim();
    addGroup = !!v.__add;
    gBtn.textContent = group ? (addGroup ? "+" : "") + "自定义源分组：" + group : "自定义源分组";
  };

  const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".imp-x").onclick = close;
  wrap.querySelector(".imp-cancel").onclick = close;
  wrap.querySelector(".imp-ok").onclick = async () => {
    const ids = boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
    if (!ids.length) return toast("没有勾选任何规则");
    close();
    const res = await api("/api/replace-rules/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(url ? { url, ids, group, addGroup } : { text, ids, group, addGroup }),
    }).catch((e) => ({ error: e.message }));
    if (!res || res.error) return toast("导入失败：" + String((res && res.error) || "未知错误"));
    toast(`导入完成：新增 ${res.added}，更新 ${res.updated}`);
    await reloadReplaceRules();
  };
}

$("replaceImport").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,.txt";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    await replacePreviewImport({ text: await file.text(), from: file.name });
  };
  inp.click();
};

$("replaceImportUrl").onclick = async () => {
  const v = await askPrompt("网络导入", "替换规则订阅 / 直链地址（http/https）", "");
  if (v === null) return;
  const url = String(v || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("仅支持 http(s) 地址");
  await replacePreviewImport({ url, from: url });
};

/* ============================================================
 *  面板开关（本地阅读器：只有替换净化 / TXT 目录规则这一个面板）
 * ============================================================ */
function closePanel(id) {
  const el = $(id);
  if (el) el.classList.add("hidden");
}

$("btnReplace").onclick = openReplace;
document.querySelectorAll("#panelReplace [data-close]").forEach((el) => {
  el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closePanel(el.dataset.close); };
});
$("panelReplace").onclick = (e) => { if (e.target === $("panelReplace")) closePanel("panelReplace"); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("panelReplace").classList.contains("hidden")) closePanel("panelReplace");
});
