# LocalReader

一个本地 TXT 小说阅读器：把磁盘上的小说文件夹导入为「书架」，直接在浏览器里分章阅读。
零依赖，只用 Node.js 内置模块，不联网、不上传任何数据。

## 下载（普通用户）

**[⬇ 下载 LocalReader.zip](https://github.com/xiaoxin0819/LocalReader/releases/latest/download/LocalReader.zip)**（34 MB）

解压后双击 `LocalReader.exe` 即可，**无需安装 Node.js**。

- 首次运行会自动打开浏览器 <http://127.0.0.1:7789/>，在界面里导入 txt 文件夹
- 配置与字体存在 `%LOCALAPPDATA%\LocalReader`（不污染 exe 所在目录）
- 换端口：在数据目录放 `port.txt` 写数字，或用 `LocalReader.exe --port 8080`

全部版本见 [Releases](https://github.com/xiaoxin0819/LocalReader/releases)。

## 特性

**书架**
- 导入任意本地文件夹作为书架，递归扫描子目录（最多 6 层）里的 `.txt` / `.md`
- 多书架切换、重命名、移除（移除只取消导入，不删文件）
- 书名筛选、按书名 / 大小 / 时间 / 阅读进度排序
- 分页显示，每页条数跟随窗口高度自适应（窗口小就少几条，全屏就多几条），不做内部滚动

**目录**
- 自动识别章节标题：`第一章` / `第 100 章` / `Chapter 1` / `序章` / `楔子` / `番外` / `卷X` 等
- 支持数字与中文数字（含 `壹贰叁`、`两`、`万`）
- 目录虚拟滚动，几千章也不卡；支持正序 / 倒序、一键回到顶部
- 首章之前的独立段落自动收进「简介」节点

**阅读**
- 正文沉浸式排版，章节标题居中
- 左右目录栏均可收起 / 展开，最大化正文区域
- 翻章动画（缓动插值、逐帧 60Hz），连续滚轮翻页
- 上一章 / 下一章，上一本 / 下一本（Alt+← / Alt+→）
- 自动记忆每本书的阅读进度（章节 + 滚动位置）

**阅读设置**
- 主题（4 套，全局生效）、字号、行距、字距、首行缩进（整段生效）、版心宽度
- 字体：宋体 / 思源宋体 / 楷体 / 黑体，以及自定义字体上传（ttf / otf / woff / woff2 / ttc）
- 自动下一章开关

**启动与加载**
- 冷启动（服务刚起来 / 首次刷新）先渲染占位文字（「正在载入书架…」「正在读取文件夹…」「正在解析《书名》…」），不再是一片空白
- 前端请求失败会自动重试（最多 10 次、退避递增）；仍失败时提示「连接阅读器服务失败，点这里重试」，点占位即可重试
- 服务端按 (mtime+size) 把「作者信息」持久化到 `.cache/authors.json`，并把书架扫描结果落盘到 `.cache/booklist/`（快照，按书架根目录哈希命名）；重启后首次列书架先秒回快照（响应带 `stale:true`）并在后台重扫，新增 / 移除书架会即时失效
- 卷标题（`卷X`/`第X卷` 等）不作为正文打开：打开该书时自动落到最近的可读章节，目录里卷行带「卷」标记

**右键菜单**
- 限定为：复制、选择、上一章 / 下一章、上一本 / 下一本；已到首尾时对应项置灰

**替换净化 / TXT 目录规则**（顶栏 `✎` 按钮打开，两个 Tab 共用同一窗口）
- 替换净化：对齐 legado `ReplaceRule` / `ReplaceRuleActivity`。支持规则启停、编辑、删除、置顶 / 置底、新建、本地 / 网络导入、测试替换、恢复内置规则，以及分组筛选与全选 / 反选
- TXT 目录规则：对齐 legado `TxtTocRule` / `TextFile.getTocRule` / `analyze`。规则同时作用于**本地分章**与**右侧目录**，即正文标题和目录项使用同一份 replacement 结果
- 内置规则来自 `sources/` 下的 JSON，默认启用项与 legado 默认数据一致；用户可自由勾选，**规则取消后会恢复原文**
- 规则引擎逐行移植 legado：`src/java-regex.mjs`（Java 正则语义）、`src/replace-engine.mjs`（内容净化，含 `@js:` 脚本）、`src/txt-toc-rules.mjs`（TXT 目录规则与 512KB 探测打分）
- 大书解析：章节目录的标题净化走 **批量执行**（`replaceManyWithRule`，一次 VM 调用处理 256 条），对齐 legado「整条规则一个 deadline」的超时语义。5290 章的 36MB 书冷解析从约 975ms 降到约 250ms

## 环境要求

- Node.js 18+（无第三方依赖，无需 `npm install`）

## 使用

Windows：

```bat
启动阅读器.bat   :: 启动服务并打开浏览器（已在运行则只开页面）
关闭阅读器.bat   :: 停止服务
```

任意平台手动启动：

```bash
node server.mjs
# 打开 http://127.0.0.1:7789/
```

### 换端口

默认监听 `7789`，三种方式任选其一（优先级从高到低）：

| 方式 | 做法 |
| --- | --- |
| 命令行 | `node server.mjs --port 8000` 或 `-p 8000` |
| 环境变量 | `set PORT=8000` 然后 `node server.mjs` |
| 配置文件 | 在程序同级（exe 模式为数据目录）新建 `port.txt`，内容写 `8000` |

其它行为（与 [Reader](https://github.com/xiaoxin0819/Reader) 项目同一套语义）：

- 端口被占用时**自动往后找空闲端口**（最多试 20 个），启动日志打印实际地址
- 没显式指定端口时重复启动，不会起第二个实例，只提示已在运行的地址
- 写 `0` 表示让系统随机分配一个空闲端口

## 打包成单文件 exe

不需要 Node 环境的独立 Windows 可执行文件，产物 `dist/LocalReader.exe`（约 90 MB）：

```bash
node build/build-exe.mjs              # 打包（含图标与版本信息）
node build/build-exe.mjs --skip-icon  # 跳过图标替换，快得多
```

原理是 Node.js SEA（Single Executable Application）：把 `parse-core.mjs` + `server.mjs` 内联成 CJS，前端资源作为 SEA assets 嵌入，`postject` 把 blob 注入 node.exe，`rcedit` 写入图标与版本信息。首次打包会自动下载 `postject` / `rcedit` 到 `build/.tmp/` 缓存。

2026-09-21 已按当前代码重新打包（含图标与版本信息）并自检通过：`dist/LocalReader.exe` 为 94,125,568 bytes，SHA256 `051DE2CEDCE03F63B83C2A51C5FB40F1977C370A5B3AE542B5316422C9A2E088`。打包脚本已同步当前 `server.mjs` 的 `replaceManyWithRule` 导入和加固后的 `serveStatic()`。

双击 exe 即启动服务并打开浏览器；已在运行则只打开页面（不重启服务）。数据目录为 `%LOCALAPPDATA%\LocalReader`（存 `reader.config.json`、`fonts/` 与 `port.txt`）。

exe 换端口：在数据目录放一个 `port.txt`（内容写数字），或用 `LocalReader.exe --port 8000` 启动。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 端口，默认 `7789` |
| `LOCALREADER_DATA` | 数据目录，默认 `%LOCALAPPDATA%\LocalReader` |
| `LOCALREADER_NO_BROWSER` | 设为 `1` 时不自动打开浏览器 |

注意：`rcedit` 必须在注入 SEA blob **之前**执行，否则会退化到极慢；打包脚本已按此顺序编排。

## 目录结构

```
server.mjs         HTTP 服务 + 静态资源 + REST API，绑定 127.0.0.1
parse-core.mjs     编码嗅探（UTF-8 / GBK / UTF-16…）、章节标题识别、简介分离
统一章节.mjs        命令行批处理：把 txt 的章节标题统一成「第N章 名称」
public/            前端（原生 HTML / CSS / JS，无构建步骤）
  index.html
  style.css
  app.js
  replace.js       替换净化 / TXT 目录规则面板逻辑
src/               legado 规则引擎移植（Java 正则语义、替换净化、TXT 目录规则）
sources/           内置替换净化规则、内置 TXT 目录规则（JSON）
fonts/             自定义字体存放目录（用户上传，不进仓库）
.cache/            运行时缓存（作者信息等，自动生成，不进仓库）
reader.config.json 运行时配置：书架、阅读进度、字体、设置（自动生成，不进仓库）
reader.ico         应用图标
build/build-exe.mjs 打包脚本（生成单文件 exe）
dist/              打包产物（不进仓库）
```

## 命令行工具：统一章节

```bash
node 统一章节.mjs <目录|文件...> [--apply] [--out=报告.jsonl] [--insert] [--quiet]
```

默认只扫描并输出报告，加 `--apply` 才写回文件。

## 说明

- 服务只监听 `127.0.0.1`，不对外暴露；所有文件读取都做了路径越界校验
- 配置数据就是 `reader.config.json` 这一个文件，删掉即恢复出厂设置
- 运行时缓存放在项目下的 `.cache/`（`authors.json` 作者信息、`booklist/` 书架快照），可随时删除；删掉只会让下次扫描稍慢，不影响阅读进度
- `.cache/booklist/` 的书架快照用于解决「书架在移动硬盘、硬盘休眠后每次重开都要等」：快照超过 7 天或损坏会自动退回真扫，前端只在数量变化时静默重绘
- 前端资源响应头带 `cache-control: no-store`，改完代码刷新页面即生效

## License

MIT
