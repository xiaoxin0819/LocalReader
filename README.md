# LocalReader

一个本地 TXT 小说阅读器：把磁盘上的小说文件夹导入为「书架」，直接在浏览器里分章阅读。
零依赖，只用 Node.js 内置模块，不联网、不上传任何数据。

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

**右键菜单**
- 限定为：复制、选择、上一章 / 下一章、上一本 / 下一本；已到首尾时对应项置灰

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
# 打开 http://127.0.0.1:7788/
```

端口被占用时改端口：

```bash
PORT=8000 node server.mjs
```

## 打包成单文件 exe

不需要 Node 环境的独立 Windows 可执行文件，产物 `dist/LocalReader.exe`（约 90 MB）：

```bash
node build/build-exe.mjs              # 打包（含图标与版本信息）
node build/build-exe.mjs --skip-icon  # 跳过图标替换，快得多
```

原理是 Node.js SEA（Single Executable Application）：把 `parse-core.mjs` + `server.mjs` 内联成 CJS，前端资源作为 SEA assets 嵌入，`postject` 把 blob 注入 node.exe，`rcedit` 写入图标与版本信息。首次打包会自动下载 `postject` / `rcedit` 到 `build/.tmp/` 缓存。

双击 exe 即启动服务并打开浏览器；已在运行则只打开页面（不重启服务）。数据目录为 `%LOCALAPPDATA%\LocalReader`（存 `reader.config.json` 与 `fonts/`）。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 端口，默认 `7788` |
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
fonts/             自定义字体存放目录（用户上传，不进仓库）
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
- 前端资源响应头带 `cache-control: no-store`，改完代码刷新页面即生效

## License

MIT
