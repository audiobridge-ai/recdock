# 在线工作台与本地助手（第一阶段）

目标：在线 HTTPS 页面负责工作台；本机助手负责录音库、账号缓存、音频处理与持久任务。Vercel 只托管静态前端，不接收录音、模型或转写请求。第一阶段提供源码开发预览；第二阶段已提供 Mac 本地测试 App 与模型准备入口，见[第二阶段交付记录](reports/macos-companion-stage2-2026-11-11.md)。

## Mac 本地测试版

解压第二阶段测试包并打开 `RecDock.app`。从助手打开固定工作台，在网页点击“连接 Mac 助手”，再在助手“网站授权”中核对地址并批准。此类授权保留 30 天，可在助手或网页撤销；重新打开网页、重启助手后可恢复。网页凭据存于当前网站的浏览器存储，助手仅持久化摘要。备用配对仍是后文所述的临时会话。

App 自带 Node、Python 与音频工具，模型在助手内选择或准备。App 默认资料根目录为 `~/Library/Application Support/RecDock`，与源码版默认目录分开；不会自动移动原录音。当前测试包适用于 Apple Silicon、macOS 26.2+，尚未完成 Developer ID 签名和公证。

## 启动

已有本地转写环境可复用。Node.js 22.18+（22.x）；当前完整模型链路面向 Apple Silicon macOS，模型、Python 和 FFmpeg 准备仍见 [development.md](development.md)。

在 `plaud-web` 目录启动助手，来源填实际网页的准确 origin：

```sh
RECDOCK_WEB_ORIGINS='https://你的实际域名' npm run companion
```

打开 `http://127.0.0.1:43127/`，确认允许来源，取得八位配对码，在在线工作台输入。配对码五分钟有效且只用一次，每分钟最多五次尝试。助手只监听 `127.0.0.1`，不接受 LAN、公网 Host 或远程 socket；来源列表不支持通配符。

无需账号即可导入本机音频。PLAUD 登录和设备材料准备仍由本机服务代理到官方 API，显式使用 ChatGPT 等云功能时仍有用户选择的外发行为。

开发时可将前端与本机服务分开：

```sh
npm run build
npm run preview:web -- --port 4173 --strictPort
```

另一个终端：

```sh
RECDOCK_WEB_ORIGINS='http://localhost:4173' npm run companion
```

打开 `http://localhost:4173/?localHelper=1`。`dev:web`、`preview:web` 不启动本机 API；查询参数仅让 loopback 前端使用同一套远程连接流程，不替换设备或转写结果。原有 `npm run dev` 与 `npm run preview` 继续提供同源本地工作台。

## Vercel 部署

2026-11-11 已创建独立项目 `recdock-plaud-web` 并完成 HTTPS 预览，实际地址和验证范围见[第一阶段记录](reports/online-companion-stage1-2026-11-11.md#本轮部署续做)。原有 `audio-bridge` 项目保留。

从 monorepo 导入时，将 Vercel 项目 Root Directory 设为 `plaud-web`。已有应用无需替换。项目内 `vercel.json` 指定 Vite、构建命令和 `dist` 输出，以及 CSP、Referrer-Policy 和权限策略。

从 `plaud-web` 目录，使用已经登录的官方 CLI 创建预览部署：

```sh
npx vercel
```

将返回的实际 HTTPS origin 加入本机 `RECDOCK_WEB_ORIGINS` 并重启助手，然后在该预览站点配对。新的预览部署可能改变 origin，需要更新允许来源。使用稳定域名后保持 origin 不变。正式发布可以使用 CLI `--prod` 或 Vercel 的部署界面；账户身份和目标项目应以实际登录结果为准。

`.vercelignore` 排除模型、Python 环境、音频、凭据、日志与测试材料。仓库的原有 `.gitignore` 也保护本地录音与账户材料。不要把模型或录音作为前端静态资产放入 `public`。

官方资料：

- [Hobby 项目与部署限制](https://vercel.com/docs/limits)：目前列出的项目上限为 200。
- [CLI](https://vercel.com/docs/cli) 与 [官方 MCP](https://vercel.com/docs/agent-resources/vercel-mcp)：MCP 对所有套餐开放，使用 OAuth；实际工具由连接授权和团队权限决定。
- [Hobby 用途限制](https://vercel.com/docs/limits/fair-use-guidelines)：非商业个人用途。企业获客网站的正式使用需按实际用途选择允许商用的套餐或托管方，不因使用免费转写而自动成为非商业用途。

## 连接协议与授权

| 入口 | 行为 |
| --- | --- |
| `GET /` | 仅本机访问的配对码页面，禁止 frame 嵌入；不会托管录音目录 |
| `GET /bridge/health` | 最小产品、协议版本与当前来源是否允许的信息，不返回账号、配对码或路径 |
| `POST /bridge/pair` | 明确允许的来源 + 一次性配对码，取得绑定该来源的随机访问令牌 |
| `DELETE /bridge/session` | 撤销当前网页授权与其文件访问凭据，保留本机文件和队列 |
| `POST /bridge/media` | 为单个音频、原件或导出路径创建限时 GET/HEAD 访问凭据 |
| `/api/*` | 保留原业务 API、账号隔离和写操作 CSRF；在线请求额外要求来源绑定的 Bearer 授权 |

在线访问不依赖跨站 Cookie，使用 `credentials: omit`；本机旧入口仍使用其原来的同源 Cookie 和 CSRF。网页令牌保存在当前标签页的 `sessionStorage`，不放入地址、日志、导出内容或应用自己的文件缓存；助手的授权表只在进程内存中保存。刷新同一标签页可恢复，助手重启后失效，十二小时无活动过期。配对许可范围包括本机录音和设备账号操作，应只授权受信任的工作台来源。

`audio` 与普通下载不能设置 Bearer 头，因此使用绑定到具体资源、最长十二小时有效的媒体凭据，支持 Range；不能用于任意 API、变更操作或另一个文件。断开网页连接后立即撤销这些凭据。下载链接不应对外分享，页面与助手响应均设置 `Referrer-Policy: no-referrer`。网页 CSP 限制网络连接到自身与 loopback 地址；加载的页面代码仍属于用户需要信任的部分。

浏览器可能要求本机网络访问权限；未授权、企业策略、服务未启动等错误并不能仅靠 `fetch` 完全区分，界面提供检查说明，不把所有网络失败误报为模型缺失。参考 [Edge LNA 文档](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access)。

## 存储与进程

助手独立于 Vite 运行。默认库仍为 `plaud-web/.local-audio/library`，复用原有迁移、锁、任务与修订机制。不要同时启动两个服务操作同一个库。关闭网页不结束助手；退出助手会停止当前进程并保留可恢复任务。转写是否可执行以实际模型环境为准，配对成功本身不代表模型就绪。

可选配置：

| 环境变量 | 用途 |
| --- | --- |
| `RECDOCK_WEB_ORIGINS` | 逗号分隔的明确允许来源 |
| `RECDOCK_COMPANION_PORT` | 本机端口，默认 43127 |
| `RECDOCK_LIBRARY_DIR` | 独立资料库路径；设置后不自动迁移旧库 |
| `RECDOCK_VAULT_FILE` | 独立加密账号缓存文件；未设置时沿用旧缓存，不自动迁移 |
| `RECDOCK_AUDIO_PYTHON`、`RECDOCK_AUDIO_MODELS` | 沿用已有 Python 与模型配置 |

实际验证时可同时设置独立的资料库与 Vault 文件，避免读取日常使用的账号和录音。不要输出、提交或上传这些文件。

## 验收

自动回归包含来源限制、Host 检查、预检、一次性配对、过期与重放、限速、令牌来源隔离、CSRF、媒体授权、Range、撤销、流式导入、修订、全文导出、持久化与界面状态。真实模型识别与浏览器 LNA 必须另行验证，不以合成稿件、内存请求或 DOM 测试替代。

在实际 HTTPS 预览地址使用真实浏览器完成：配对 → 导入一段已知内容的语音 → 完成模型转写 → 时间回听 → 保存校对 → 导出 → 刷新后恢复。另用稍长音频检查关闭网页后任务继续，以及重启助手后资料保留、重新配对、未完成任务恢复。更换网页来源时检查蓝牙权限重新授予；现有 ChatGPT 扩展尚未扩展到公网工作台来源。
