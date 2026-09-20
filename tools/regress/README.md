# 回归脚本

验证本地阅读器的核心逻辑：替换净化引擎的批量 / 逐条等价性、超时语义、书架快照。

## 脚本

| 脚本 | 验证内容 | 依赖 |
| --- | --- | --- |
| `verify-batch-edge.mjs` | 批量替换与逐条替换在各种规则下结果一致；病态规则抛 `RegexTimeoutError` | 无 |
| `verify-timeout-semantics.mjs` | 整批超时 → 退回逐条 → 逐条超时 → 抛错（对齐 legado） | 无 |
| `verify-batch-equivalence.mjs` | 用配置里的真实规则跑批量 vs 逐条对比 | `reader.config.json` |
| `verify-realbook-titles.mjs` | 真实大书的章节标题：批量路径与逐条路径逐条一致 | `reader.config.json` + 书架 txt |
| `verify-bookshelf-snapshot.mjs` | 冷启动扫描 vs 重启后快照命中（书架秒开） | `reader.config.json` |

## 用法

```bash
cd 阅读器
node tools/regress/verify-batch-edge.mjs
node tools/regress/verify-timeout-semantics.mjs
```

需要真实书籍的脚本（`reader.config.json` 里要有书架）：

```bash
# 默认取书架里最大的那本 txt
node tools/regress/verify-realbook-titles.mjs

# 指定书名关键字
node tools/regress/verify-realbook-titles.mjs "书名关键字"
```

## 说明

- 这些脚本**只读**：不改配置、不写书架、不启动正式服务（`verify-bookshelf-snapshot` 用独立端口）。
- `reader.config.json` 是本机个人配置（书架路径、阅读进度），**不进仓库**；
  所以依赖它的脚本需要你先在界面里导入过书籍才能跑。
