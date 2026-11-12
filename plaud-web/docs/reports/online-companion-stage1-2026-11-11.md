# 在线工作台与本地助手第一阶段记录

日期：2026-11-11。

后续进度：Mac 本地测试版已完成真实语音、后台恢复、网页校对与导出验收，见[第二阶段交付记录](macos-companion-stage2-2026-11-11.md)。本文件保留第一阶段结束时的实现与剩余验收快照。

结论：源码实施、自动检查、独立 HTTPS 预览部署和真实浏览器页面加载已完成；本机助手配对、真实模型与设备联调尚未验收。本记录不代表第一阶段完整端到端通过。

## 本次实现

- `server/companion/main.ts`：独立于 Vite 的本机进程，固定监听 loopback，复用原资料库、任务与转写 Worker。
- `server/companion/bridge.ts`：明确来源允许列表、八位一次性码、限速、进程内来源绑定令牌、撤销与单资源文件凭据。
- `server/http.ts`：经助手验证的远程请求绑定独立业务会话，不依赖跨站 Cookie；保留本机原有 Cookie、CSRF 与账号隔离。
- `src/local`：在线连接面板、协议握手、标签页连接恢复、地址约束、过期事件和连接说明。
- `src/auth/cloud.ts`、`src/library/client.ts`、`src/library/workspace.ts`：统一请求传输，上传携带授权，播放和下载使用文件凭据，防止异步切换录音时写回旧播放地址。
- `dev:web` / `preview:web`：只提供前端，用于与助手分开启动；原开发入口仍提供同源服务。
- `vercel.json` 与 `.vercelignore`：静态部署、页面策略与私有文件排除规则；本轮续做已创建独立 Vercel 预览项目，见下文。

使用与部署见 [online-companion.md](../online-companion.md)。图形安装包、模型自动准备、官网营销内容和 App 分发属于后续阶段。

## 验证结果

| 检查 | 结果与证明范围 |
| --- | --- |
| 完整 JavaScript 回归 | 前轮 347 项通过，0 失败，0 跳过；本轮再次执行 12 项助手、客户端和界面测试，全部通过 |
| TypeScript 与生产构建 | `npm run build` 通过；产物为静态前端 |
| 差异格式 | `git diff --check` 通过 |
| 产物检查 | `dist` 含 6 个静态文件，包括连接说明；未发现模型、音频或密钥文件 |
| 授权与协议 | 通过内存请求流检查来源、Host、预检、配对、限速、过期、重放、CSRF、Range、单文件范围与撤销 |
| 磁盘资料库 | 使用临时目录、生成的 WAV 和合成转写稿验证流式导入、修订、完整导出和服务对象重建后的资料恢复；不验证语音识别质量 |
| 界面状态 | JSDOM 验证首次连接不请求本机账号、来源提示、配对后清码、断开、刷新凭据恢复和失效事件；不等同于真实浏览器验证 |
| HTTP listener / 浏览器 | 前轮本机预览与助手监听受 `EPERM` 限制；本轮真实 Microsoft Edge 已加载 HTTPS 工作台，显示本地助手地址、一次性码输入框和“尚未连接”。未验证本机网络许可与实际配对 |
| MLX GPU | 预检查返回 `No Metal device available`；未执行真实音频的模型推理，不以合成稿件代替 |
| Vercel | 官方插件账号与团队授权验证通过；独立 Preview 已达 `READY`，首页、连接说明和主脚本均返回 HTTPS 200，页面安全响应头生效 |

本轮未修改模型推理与 App 业务代码，未重跑 Python Worker 或 Flutter 基线。临时验证资料位于系统临时目录，不进入仓库。

## 本轮部署续做

- 账号：`chentiansaber`。团队：`chentiansabers-projects`（`team_sqcN39UbrgP8CGHd4AjMOwTJ`）。首次读取项目返回团队访问 403；用户完成插件生成的团队授权后，团队和项目读取成功。
- 原有项目：`audio-bridge`（`prj_JDYHk4XAdLLdDTw4pmFUW2OPmBwI`）。部署前后 `get_project` 返回内容一致，包括 `updatedAt = 1790061721591`；本轮所有创建、配置和部署操作均指向新项目。
- 新项目：[`recdock-plaud-web`](https://vercel.com/chentiansabers-projects/recdock-plaud-web)（`prj_bGCPcFgyzpCDkFwQX6035FVIt6IQ`）。Root Directory 为 `plaud-web`，Vite，Node `22.x`，安装 `npm ci`，构建 `npm run build`，输出 `dist`。
- 部署：[`dpl_XDYotftzx68fZc4bA2DRBcakXaa9`](https://vercel.com/chentiansabers-projects/recdock-plaud-web/XDYotftzx68fZc4bA2DRBcakXaa9)，状态 `READY`。API 创建请求显式使用 `target: staging`，并通过 `list_deployments(target: preview, state: READY)` 查到该部署，确认其属于 Preview。原始 API 的目标参数说明见[官方文档](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)。
- 实际 HTTPS 地址：[打开预览](https://recdock-plaud-l50ealf9v-chentiansabers-projects.vercel.app/)。预览保留 Vercel Authentication；浏览器使用账号现有登录状态访问成功，未关闭部署保护。
- 来源：当前未提交的本地工作区，基于 `4740c5424e301e2753998fd5df9a9e47a6da94d5`，不是仅部署该提交。上传 70 个明确选定的源码、契约、构建配置和公共资源，共 678,694 字节；不含录音、模型、Vault、环境文件、测试、文档或 App 工程。[部署清单](online-companion-stage1-deploy-manifest-2026-11-11.json)记录各文件 SHA-1 与大小，清单规范化 SHA-256 为 `e04f387fc3b7563b6fc807c5ff826806cf80b5a4d0240e4693100caacc2d97d9`。
- 构建修复：补齐锁文件中缺少的 24 个 Lightning CSS / Rolldown 平台可选包条目，使用 npm 官方注册表的原固定版本、下载地址和完整性值；既有包版本未变。`package.json` 与锁文件的 Node 范围收敛为 `>=22.18.0 <23`。临时 Vercel 环境仅用于读取这些元数据，均已停止且未保存快照。
- 失败记录：首次省略目标参数的部署被平台标记为 Production，但因锁文件缺项构建失败，未产生可用生产版本；重试发现上传清单漏了 `index.html`，补齐后先在独立快照目录完成生产构建，再完成上述 Preview。曾尝试的 `target: preview` 被 API 拒绝，随后按其协议使用 `staging`。
- HTTP 验证：首页、`connection-guide.html` 和 `assets/index-DjOY6OzG.js` 返回 200；首页 `Content-Security-Policy`、`Permissions-Policy`、`Referrer-Policy`、`X-Frame-Options`、`X-Content-Type-Options` 与配置一致，并含 HSTS、`noindex`。
- 浏览器验证：Microsoft Edge 在实际 HTTPS origin 下显示工作台、录音列表、本地助手连接面板和“请先连接本地助手，再导入或读取本机录音”。自动化首次键入临时访问链接时字符缺失而进入搜索页，该临时链接随后已撤销；改用粘贴标准 URL 后正常访问。临时访问参数不写入文档或部署清单。

下一步启动助手时，使用此部署的准确来源：

```sh
cd plaud-web
RECDOCK_WEB_ORIGINS='https://recdock-plaud-l50ealf9v-chentiansabers-projects.vercel.app' npm run companion
```

再打开 `http://127.0.0.1:43127/` 取得一次性配对码，在预览工作台完成配对。若重新部署后改用新 URL，应同步更新允许来源并重启助手。

## 剩余验收

1. 在允许本机监听且可访问 Metal 的环境启动助手，把上述实际预览 origin 加入允许列表，完成浏览器本机网络访问授权和一次性配对。
2. 使用已知内容的语音完成真实转写、时间回听、校对保存、全文导出和刷新恢复。
3. 验证关闭网页后任务继续、助手退出后任务恢复、重新配对后资料仍可读取；在新 origin 下检查真实蓝牙设备权限和连接。

Vercel Hobby 当前官方列出最多 200 个项目，并支持 CLI；官方 MCP 对所有套餐开放。Hobby 的非商业个人用途限制仍适用，企业获客用途应在正式使用前按实际用途选择合适托管方案。详见实施文档中的官方链接。
