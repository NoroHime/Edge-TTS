# novel-tts Web · Edge TTS 在线朗读

把 Python 桌面版 **novel-tts**（`GUI_QWENv6.pyw` + `tts_backends.py`）里的
**Edge TTS 引擎**移植成了 TypeScript 应用：

- 不需要安装 Python、`edge-tts`、`soundfile`，**也不需要 FFmpeg**；
- 生成与播放并行：第一段生成完就开始播，后续片段边生成边播；
- 播放到最后一段就停止，**不会回到第一段循环**；
- 全部生成完成后可以把所有片段拼成一个 WAV 下载。

> ⚠️ 这是微软 Edge 浏览器的**非公开接口**，不是官方 SDK。
> 音频由微软服务器生成，需要联网；接口随时可能变更或被限制。
> 请勿用于商业用途或大规模自动化请求。

---

## ⚠️ 必读：为什么 Chrome / 手机浏览器会「连续尝试 3 次仍未成功」

如果你看到：

```
状态：生成失败：Error: Edge TTS 请求失败：连续尝试 3 次仍未成功。
最后错误：Error: Edge TTS WebSocket 握手失败（HTTP 403）
```

**这不是网络问题，也不是代理开关的问题，更不是必须用 Edge。**
原因是微软的合成服务在 **WebSocket 握手阶段强制要求 `User-Agent` 请求头**，
而浏览器的 WebSocket API **不允许网页设置 `User-Agent`**
（它属于 HTML 规范里的 forbidden header name，浏览器直接忽略页面的设置）。

实测证据（同一台机器、同一个 IP、同一个令牌，只改请求头）：

| 握手请求头 | 服务端响应 |
| --- | --- |
| 带 `User-Agent` | `HTTP/1.1 101 Switching Protocols` ✅ |
| `User-Agent` + `Origin` | `HTTP/1.1 101 Switching Protocols` ✅ |
| **不带 `User-Agent`** | **`HTTP/1.1 403 Forbidden`** ❌ |
| 只带 `Origin` / 只带 `Cookie` | `403 Forbidden` ❌ |

所以：

- **桌面 Edge 能用** —— Edge 自己在握手时带了正确的 `User-Agent`；
- **Chrome / Firefox / Safari / 手机浏览器全部失败** —— 它们带的 `User-Agent`
  是浏览器自己的，微软不认；
- 换不换代理都一样 —— 因为缺的是请求头，不是网络出口。

### 解决办法：加一个中转（代理）

因为 GitHub Pages 只能托管静态文件、无法替浏览器补请求头，
所以需要一个能补 `User-Agent` 的服务端中转。本仓库已经提供现成的
[`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js)（Cloudflare Workers，免费）：

1. 注册 <https://dash.cloudflare.com>（免费账号，不用绑卡）
2. 左侧 **Workers & Pages** → **Create** → **Worker**，随便起个名字（例如 `edge-tts-proxy`）
3. 把 [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js) 的全部内容粘进去，**Deploy**
4. 记下地址，形如 `https://edge-tts-proxy.你的子域.workers.dev`
   （先在浏览器打开它，应该看到 `{"ok":true,...}` 的 JSON）
5. 在项目根目录建一个 `.env.local`：

   ```
   VITE_EDGE_TTS_PROXY=wss://edge-tts-proxy.你的子域.workers.dev
   ```

6. 重新构建并推送：

   ```bash
   pnpm build && git add -A && git commit -m "启用 Edge TTS 中转" && git push
   ```

   如果用 GitHub Actions 自动发布，则把这个环境变量加到
   **Settings → Secrets and variables → Actions → Variables** 里，
   变量名 `VITE_EDGE_TTS_PROXY`，并在
   [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 的
   `pnpm run build` 那一步加上 `env: VITE_EDGE_TTS_PROXY: ${{ vars.VITE_EDGE_TTS_PROXY }}`。

配好之后 Chrome / Firefox / 手机浏览器都能正常合成。

> 中转只做「补请求头 + 转发字节流」，音频是边收边转发的，不会在服务端落盘。
> 建议在 Worker 里设置 `ALLOWED_ORIGINS` 变量（你的站点来源），
> 免得被别人白用，例如：`https://norohime.github.io`。
>
> **替代方案：**如果你不想用 Cloudflare，也可以自己在任何能跑 Node/Python
> 的地方跑一个中转（核心逻辑就是「收到连接 → 带上 `User-Agent` 连上游 → 双向转发」）。
> [`tools/relay-check.mjs`](tools/relay-check.mjs) 就是一个最小可用的 Node 实现，
> 可以直接拿来当参考或改成本地服务。

### 一句话总结

| 场景 | 能否合成 |
| --- | --- |
| 页面直连（未配置 `VITE_EDGE_TTS_PROXY`），用桌面 Edge 打开 | ✅ |
| 页面直连，用 Chrome / 手机浏览器打开 | ❌ 必然 403 |
| 配置了中转代理 | ✅ 任意浏览器 |

---

## 目录

- [必读：为什么 Chrome / 手机浏览器失败](#️-必读为什么-chrome--手机浏览器会连续尝试-3-次仍未成功)
- [与 Python 版的对应关系](#与-python-版的对应关系)
- [本地开发](#本地开发)
- [测试](#测试)
- [上线到 GitHub Pages](#上线到-github-pages)
- [目录结构](#目录结构)
- [已知限制](#已知限制)

---

## 与 Python 版的对应关系

| Python（原版） | TypeScript（本仓库） | 说明 |
| --- | --- | --- |
| `split_sentences` / `hard_split` / `join_text_units` / `split_text` | [`src/text.ts`](src/text.ts) | 逐行等价移植，分段结果与 Python 完全一致 |
| `read_text_file`（UTF-8 / GBK 探测） | [`src/utils.ts`](src/utils.ts) `readTextFile` | 用 `TextDecoder` 支持 `utf-8` / `gb18030` / `gbk` / `big5` |
| `format_time` / `preview_text` | [`src/utils.ts`](src/utils.ts) | 相同输出格式 |
| `EdgeBackend`（edge-tts + FFmpeg + soundfile） | [`src/edgeTts.ts`](src/edgeTts.ts) | 改为浏览器 WebSocket，直接拿 MP3，无需 FFmpeg |
| `edge_save_with_retry`（60 秒超时、最多 3 次、递增延迟） | [`src/edgeTts.ts`](src/edgeTts.ts) `synthesizeWithRetry` | 行为一致 |
| `GenerateThread`（边生成边发信号） | [`src/generator.ts`](src/generator.ts) | 异步流程，每段生成完立即回调 |
| `ExportThread`（多段合并成一个 WAV） | [`src/audio.ts`](src/audio.ts) `mergeBlobsToWav` | 解码 + PCM 16bit 重编码 |
| `QMediaPlayer` + 播放状态机 | [`src/playback.ts`](src/playback.ts) + [`src/app.ts`](src/app.ts) | 用 `HTMLAudioElement` 重建同一套“自动接续 / 等待下一段 / 最后一段停止”逻辑 |
| `MainWindow` 界面 | [`src/app.ts`](src/app.ts) + [`src/template.ts`](src/template.ts) | 同样的分区：设置 / 文本 / 进度 / 片段 / 播放 / 日志 |

### 分段逻辑已被对照测试验证

[`tools/gen_reference.py`](tools/gen_reference.py) 里**逐字复制**了原版 Python 函数，
[`tests/parity.test.ts`](tests/parity.test.ts) 会把两边的结果逐项比对：

- 15 组文本分段（含引号、省略号、无标点超长文本、中英混排等）；
- 5 组按字节切分（含 `<`、`>`、`&` 转义后的文本）；
- 3 组 `Sec-MS-GEC` 令牌（`SHA-256` 算法必须与微软的校验一致）。

```
OK - 30 checks passed (text splitting / byte splitting / Sec-MS-GEC)
```

---

## 本地开发

需要 Node.js 18+（建议 22+，测试脚本用到了原生的 TypeScript 类型擦除）和 pnpm。

```bash
cd Edge-TTS

pnpm install

pnpm dev        # 开发服务器，默认 http://localhost:5173/Edge-TTS/
pnpm build      # 类型检查 + 打包到 dist/
pnpm preview    # 预览打包结果，默认 http://localhost:4173/Edge-TTS/
```

> 注意：`vite.config.ts` 里的 `base` 必须等于**仓库名**（当前是 `Edge-TTS`）。
> 如果你把仓库改成别的名字，这一行也要跟着改，否则 GitHub Pages 上会 404。

---

## 测试

```bash
# 1) 协议自检：用假的 WebSocket 服务端验证请求格式、音频帧解析、重试逻辑（不联网）
pnpm test:protocol

# 2) 与 Python 原版逐项对照（需要本机有 python）
pnpm fixtures   # 生成 build/python-reference.json
pnpm test:parity
```

两项都跑：

```bash
pnpm test
```

协议自检覆盖：

- 连接 URL 是否带 `TrustedClientToken` / `Sec-MS-GEC` / `Sec-MS-GEC-Version` / `ConnectionId`；
- `speech.config` 与 SSML 请求的头部格式；
- 二进制音频帧（前两字节为大端头部长度）是否正确剥离；
- `turn.end` 是否返回完整音频；
- 超过 4096 字节的文本是否自动拆成多次请求并按顺序拼接；
- 连接断开后是否按配置重试。

---

## 上线到 GitHub Pages

### 第 0 步：先想清楚网址

GitHub Pages 的**项目站点**地址规则是：

```
https://<用户名>.github.io/<仓库名>/
```

所以仓库名基本决定了网址：

| 仓库名 | 上线后的网址 | `vite.config.ts` 里的 `base` |
| --- | --- | --- |
| `Edge-TTS` | `https://norohime.github.io/Edge-TTS/` | `'/Edge-TTS/'`（当前配置） |
| `norohime` | 项目站点会占用 `https://norohime.github.io/norohime/` | 需要按子目录再调，不推荐 |

你现在这个目录（`B:\Documents\norohime.github.io`）**本身还不是一个 git 仓库**，
它是你放各个项目的文件夹。所以推荐做法是：新建一个**独立仓库**，把
`Edge-TTS/` 里的内容作为该仓库的根目录。

> GitHub Pages 的项目站点地址只能由**用户名 + 仓库名**决定，
> 没有办法直接得到 `norohime.github.io/norohime/Edge-TTS/` 这样的三段路径
> （除非真的建一个叫 `norohime` 的仓库并在里面再放一层 `Edge-TTS` 目录）。
> 如果你确实想要那个网址，见本文末尾的「备选：保留 /norohime/Edge-TTS 路径」。

### 第 1 步：在 GitHub 上新建空仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `Edge-TTS`
3. 选择 Public（Pages 免费版需要公开仓库，或你有 Pro 账号）
4. **不要**勾选 "Add a README file" / ".gitignore" / "license"（保持空仓库）
5. 点 **Create repository**

### 第 2 步：在本地把 Edge-TTS 变成 git 仓库并推送

在 PowerShell 里执行（把路径换成你的实际路径）：

```powershell
cd "B:\Documents\norohime.github.io\Edge-TTS"

git init
git branch -M main
git add .
git commit -m "novel-tts Web: Edge TTS 纯前端 TypeScript 版本"

git remote add origin https://github.com/norohime/Edge-TTS.git
git push -u origin main
```

`git add .` 之前可以确认一下 `.gitignore` 已经排除了 `node_modules/` 和 `dist/`
（仓库里已经提供了这个文件），所以推送的只有源码。

### 第 3 步：开启 GitHub Pages（用 GitHub Actions）

本仓库自带工作流 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)，
它会在每次 `push` 到 `main` 时自动执行：

```
pnpm install → pnpm run build（含 tsc 类型检查）→ 上传 dist/ → 发布 Pages
```

你只需要在仓库里打开一次开关：

1. 进入仓库 → **Settings** → 左侧 **Pages**
2. **Build and deployment** → **Source** 选择 **GitHub Actions**
3. 回到 **Actions** 标签，可以看到 **Deploy to GitHub Pages** 工作流开始运行
4. 等工作流变绿（大约 1 分钟）

完成后访问：

```
https://norohime.github.io/Edge-TTS/
```

> 如果工作流失败，点进去看日志。最常见的原因是 `pnpm-lock.yaml` 与
> `package.json` 不一致，此时本地执行一次 `pnpm install` 再提交即可。

### 第 4 步：验证线上版本

打开线上网址后确认：

- 页面标题是「novel-tts Web · Edge TTS 在线朗读」；
- 浏览器控制台（F12）没有红色报错；
- 粘贴一段中文 → 点「开始生成」→ 第一段生成后自动开始播放；
- 生成过程中可以「暂停 / 继续」「上一段 / 下一段」「停止」；
- 全部生成完后点「导出 WAV」能下载一个完整音频。

### 备选 A：不用 Actions，直接发布 dist

如果你更想手动发布：

```powershell
cd "B:\Documents\norohime.github.io\Edge-TTS"
pnpm build

# 把 dist 的内容推到 gh-pages 分支
npx gh-pages -d dist
```

然后在 **Settings → Pages** 里把 **Source** 改成 **Deploy from a branch**，
分支选 `gh-pages`、目录选 `/ (root)`。

> 这种做法需要仓库里能访问 `gh-pages` 分支，而且 `dist/` 目前被 `.gitignore` 排除了，
> 用 `npx gh-pages -d dist` 时不会受影响（它自己读文件、自己建分支）。

### 备选 B：部署到 norohime.github.io 的子目录

如果 `norohime.github.io` 以后要变成一个真正的 git 仓库
（也就是把整个文件夹当成用户站点仓库 `norohime/norohime.github.io` 来推送），
那么直接把 `Edge-TTS/` 作为一个子目录放进去也可以，网址会是：

```
https://norohime.github.io/Edge-TTS/
```

这种情况不需要改 `base`（仍然是 `'/Edge-TTS/'`），因为 URL 路径刚好
就是子目录名。用户站点仓库（`<用户名>.github.io`）的分支发布规则是
**从 `main` 分支的根目录**发布，所以子目录会原样出现在网址里。

### 备选 C：保留 `/norohime/Edge-TTS` 这个三段路径

想要 `https://norohime.github.io/norohime/Edge-TTS/`，需要：

1. 新建一个名为 `norohime` 的仓库；
2. 在仓库根目录建 `Edge-TTS/` 子目录，把本项目**构建后的 `dist/` 内容**放进去；
3. `vite.config.ts` 的 `base` 改成 `'/norohime/Edge-TTS/'`；
4. 用 Actions（把 `path` 改成发布 `norohime/Edge-TTS`）或 `gh-pages` 发布。

> 更省事的替代方案：主站照常发布到 `https://norohime.github.io/Edge-TTS/`，
> 然后在 `norohime.github.io` 主站里加一个 `/norohime/Edge-TTS/index.html`，
> 内容只有一句跳转：
>
> ```html
> <meta http-equiv="refresh" content="0; url=/Edge-TTS/">
> ```

---

## 目录结构

```
Edge-TTS/
├── index.html                  # HTML 入口（Vite 模板）
├── vite.config.ts              # base 必须等于仓库名
├── tsconfig.json               # 严格模式
├── package.json
├── pnpm-lock.yaml
├── .github/workflows/deploy.yml  # 自动发布到 GitHub Pages
├── src/
│   ├── main.ts                 # 入口：渲染界面 + 启动应用
│   ├── app.ts                  # 主程序（对应 MainWindow，含播放状态机）
│   ├── template.ts             # 界面模板（对应 _build_ui）
│   ├── styles.css
│   ├── constants.ts            # 超时/重试参数、服务地址、输出格式
│   ├── text.ts                 # 文本分段（对应 split_text 系列）
│   ├── splitter.ts             # 生成前的分段封装
│   ├── bytelength.ts           # SSML 4096 字节切分
│   ├── edgeTts.ts              # Edge TTS 客户端（对应 EdgeBackend）
│   ├── generator.ts            # 逐段生成（对应 GenerateThread）
│   ├── playback.ts             # HTMLAudioElement 播放控制器
│   ├── audio.ts                # 归一化 / WAV 合并（对应 ExportThread）
│   ├── voices.ts               # 音色列表
│   └── utils.ts                # 日志、时间格式化、读文件、下载
├── tests/
│   ├── protocol.test.ts        # Edge TTS 协议自检（不联网）
│   └── parity.test.ts          # 与 Python 原版对照
├── proxy/
│   └── cloudflare-worker.js    # WebSocket 中转（补 User-Agent），部署到 Cloudflare Workers
└── tools/
    ├── gen_reference.py        # 生成对照样例（复制自原版 Python 函数）
    ├── handshake-debug.mjs     # 打印服务端原始握手响应（证明 User-Agent 是必需的）
    ├── live-check.mjs          # 逐个测试请求头组合，找出被拒原因
    ├── proxy-check.mjs         # A/B 对照：带/不带 User-Agent 的握手结果
    └── relay-check.mjs         # 最小可用的 Node 中转实现 + 端到端验证
```

> `build/` 目录只在本地生成对照样例时使用，已加入 `.gitignore`。
>
> `tools/` 里的网络排查脚本只在需要诊断时手动运行，不参与构建。
> 其中 `relay-check.mjs` 需要 `pnpm add -D ws`（临时装一下即可）；
> 它同时也是一个可以直接参考/改造的最小中转实现。

---

## 已知限制

1. **必须联网**，且依赖微软的非公开接口。接口变更会导致合成失败（页面会在日志里显示原因）。
2. **非 Edge 浏览器必须配置中转代理**（见开头「必读」一节），
   因为微软在握手阶段强制要求 `User-Agent`，而浏览器不允许网页设置该头。
3. **`Sec-MS-GEC-Version` 必须跟随上游更新**。服务端会校验这个 Chromium 版本号，
   版本太旧会直接 403。当前值在 [`src/constants.ts`](src/constants.ts)
   （`CHROMIUM_FULL_VERSION`），与 `edge-tts` 7.2.8 一致；上游更新时应同步修改。
4. **语速 / 音调 / 音量使用 SSML 韵律参数**，与 Python 版“用播放器变速”不同。
   播放速度（`0.50x`–`2.00x`）仍然是播放器层面的，不改动已生成的音频。
5. **音色列表接口只有 HTTP 版本**。GitHub Pages 是 HTTPS，浏览器会拦截混合内容，
   所以点击「获取全部」可能失败，此时会继续使用内置的 6 个中文音色
   （与 Python 版完全一致）。
6. **FFmpeg 已不再需要**：浏览器直接拿到 MP3 播放，导出时才重编码为 WAV。
7. **长文本会分批请求**：单次 SSML 正文上限 4096 字节，超出会自动拆成多次请求再拼接。
   （上游 `edge-tts` 在“整段没有换行和空格”的极端情况下会发出一个超过上限的请求，
   本移植版刻意修正为严格不超过上限，`tests/parity.test.ts` 里对此有说明。）
8. **片段音频保存在内存里**。非常长的文本（例如几十万字）会占用较多内存，
   建议一次处理一章。
9. 原版的 **Qwen3-TTS** 和 **MeloTTS** 引擎依赖本地模型和 CUDA，无法在浏览器里运行，
   因此本版本只保留 Edge TTS 引擎。
10. **中转代理有被滥用的风险**。Worker 是公开地址，建议配置 `ALLOWED_ORIGINS`
    限制来源；如果流量很大，Cloudflare 免费额度（每天 10 万次请求）可能不够。

---

## 许可

与上游项目保持一致，仅供个人学习与自用。
