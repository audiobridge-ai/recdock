# Mac 本地助手第二阶段交付记录

日期：2026-11-11。

结论：达到用户确认的“本地可测试版本”目标。原生菜单栏 App、自带处理运行时、网站授权、既有模型校验和真实语音处理闭环已在当前 Mac 验证。用户尚未开通 Apple Developer，已明确将公开签名与公证延后；本次产物不作为公开分发版或干净 Mac 全新安装通过的证明。

## 使用入口

- App：仓库内 `companion-macos/dist/local-2026-11-11-i/RecDock.app`。
- 测试安装包：`companion-macos/dist/local-2026-11-11-i/RecDock-0.2.0-macos-arm64.zip`，约 345 MB。
- ZIP SHA-256：`13436292dfae4f385539064db1f475ba6f8a69909affc8c68474c68e71f24974`。
- 适用当前包：Apple Silicon，macOS 26.2 及以上。最低系统要求由本机打包的 FFmpeg 动态库决定，尚未验证较旧 macOS。
- 固定工作台：[RecDock 预览](https://recdock-plaud-web-chentiansabers-projects.vercel.app/)。保留 Vercel Authentication。
- 最终预览部署：`dpl_5Pkip2J4HLHkkDKf62dwkr7BGPoR`，状态 `READY`、API 目标 `staging`（Preview），位于独立项目 `recdock-plaud-web`。原 `audio-bridge` 的 `updatedAt` 仍为 `1790061721591`，原生产部署保持不变。
- 启动 App 后从菜单栏或窗口打开工作台。首次点击“连接 Mac 助手”，在助手“网站授权”中核对网站并允许；无需输入配对码。备用配对码入口保留。

本机模型目录已通过文件选择器指向原有模型并完成校验，无需重新下载。资料、授权和设置默认放在 `~/Library/Application Support/RecDock`。源码版原有录音与账号缓存保留原位置，本次未迁移。验收在新的资料库中留下了一条 12 秒语音样本，供继续查看。

## 实施内容

1. `companion-macos/Sources`：AppKit 菜单栏应用，提供服务启停、退出、工作台入口、模型准备、环境检查、网站授权与撤销、用户选择的登录自启入口。关闭窗口或网页不停止服务；退出助手会停止并保留任务。
2. `companion-macos/scripts/build.py`：预编译 Node 服务为 JavaScript，打包 Node 22、独立 Python 3.11、生产依赖、FFmpeg/FFprobe 与预编译 Swift 辅助程序；解析和改写非系统动态库依赖，逐一签名并校验嵌入代码。当前产物含 378 个 Mach-O 文件。
3. `scripts/refresh_local.py`：仅在依赖锁未改变、基包签名校验通过且为本地 ad-hoc 版本时，复用已验证运行时更新应用代码；不覆盖旧包，不用于修改 Developer ID 分发包。
4. `server/companion/trust.ts` 与 `bridge.ts`：本机管理凭据、网站确认与 PKCE 交换、30 天授权、来源绑定、持久化令牌摘要、撤销、请求过期及重放限制。管理入口拒绝网页 Origin；持久化文件不存可直接使用的网页令牌。
5. `src/local`：自动健康检测、Mac 助手授权入口、当前网站的持久授权恢复；临时配对仍使用标签页会话。正文、媒体与上传继续经过既有授权边界。
6. 模型准备沿用固定修订与文件完整性校验。Hugging Face 令牌的保存入口使用本机钥匙串，界面提供官方模型许可入口，不代替用户接受条款。
7. 音频工具使用包内绝对路径；工具被系统信号终止时报告环境问题，避免误判音频损坏。修复环境后重新导入同一原件会重新检查并复用原录音。
8. Worker 保留 App 提供的用户缓存路径，避免向签名 App bundle 写入运行状态。准备任务由独立进程组管理，取消时终止其子进程。

## 自动验证

| 检查 | 结果与范围 |
| --- | --- |
| JavaScript 回归 | 355 项通过，0 失败、0 跳过；覆盖持久授权、来源隔离、撤销、取消、坏存储拒绝访问，以及音频工具故障恢复 |
| Python 回归 | 39 项通过；不以合成模型输出代替真实语音验收 |
| TypeScript / Vite | `npm run build` 通过 |
| Swift | 原生 App 与辅助程序编译通过；设置恢复、用户资料路径、独立管理凭据和网站地址约束测试通过 |
| 运行时独立性 | Python 的 `prefix`、`base_prefix` 和模块搜索路径均位于当前 App 内；包内 Python/Torch/Hugging Face、FFprobe 和 Node 服务模块检查通过 |
| 签名完整性 | 真实处理与导出后，`codesign --verify --deep --strict` 仍通过；此处为 ad-hoc 完整性校验，不代表 Developer ID 或 Apple 公证 |
| 工作区 | `git diff --check` 通过；未提交或覆盖前轮已有改动 |

结构化证据见[验收摘要](macos-companion-stage2-evidence-2026-11-11.json)，最终前端源码清单见[部署清单](macos-companion-stage2-web-manifest-2026-11-11.json)。这些文件不包含网页令牌、账号凭据、音频或正文。

## 真实交互验收

设备：当前 Apple M3 Pro Mac。通过实际 App 窗口与 Microsoft Edge 操作，未通过终端启动最终服务或向网页注入模拟接口。

- App 中环境检查显示处理环境通过、Metal 可用；既有 3.5 GB 模型经过完整性校验。
- 网页准确检测本机助手。用户在会话中明确批准该固定网站访问后，才点击本机“允许”。网页显示“已连接 · 本机处理”。
- 导入既有中文真实语音基准的 12 秒片段，原件 SHA-256 为 `21d0985aff0c87fe4d92681d6ead82a98c2786e7ddbc9503cd4db691cc8c9532`；上传后与原件字节一致。
- 关闭网页时，助手仍显示有任务处理。中途停止并重新启动后台服务后，同一任务恢复执行。
- 任务 `job_87fd8573a85b4c3b91c443365c6668c9` 最终 `succeeded`，`attempt = 2`、`resumed = true`，完成 `preparing / transcribing / aligning / diarizing / merging` 全部阶段。实际生成两段正文与两位讲话人，未安装合成转写稿替代模型结果。
- 重新打开网页后自动恢复已授予的网站授权，无需再次输入代码；原录音仍可读取。
- 点击段落时间后浏览器显示正在播放，第二段定位至约 7 秒；播放进度实际推进。
- 在网页修改第一段标点并保存，显示“修改已保存到本机录音库”。人工修改保留独立版本与原始机器稿，不将校对操作冒充模型输出。
- 导出的完整 Markdown 已由 Edge 下载，文件含校对后的第一段与第二段全文。文件为 848 字节，SHA-256：`6759052f06f59687d14bb4873a283eee199116ee1a2083442d0e0af579472557`。
- 刷新网页后再次自动连接；打开录音仍可见已保存的标点与人工修改标识。

此短样本验证处理、媒体和持久化链路，不构成识别准确率、长录音性能或扬声器听感的量化评价。未向 ChatGPT 或其他云端发送验收录音与正文。

## 联调中修复的问题

- 禁用 Node JIT 会使内置 TypeScript 转换器和网络请求所需的 WebAssembly 不可用。最终服务使用预编译 JavaScript 与标准 Node 能力，不沿用该限制。
- 包内 FFmpeg 通过相对名称启动时曾收到 `SIGKILL`，通过固定完整路径启动成功。最终 Node 与 Python 处理链均使用明确的包内工具路径，并新增故障分类与重复导入恢复回归。
- Python 轮子带有当前流程不使用、依赖旧版 FFmpeg / SoX 的可选解码插件。包内移除这些不可加载的插件，保留原有“FFmpeg 解码为 PCM 后传给 pyannote”的路径；实际讲话人识别已通过。
- 所有测试数据和运行状态保存在用户资料目录或系统临时目录，未打入 App 或上传到 Vercel。

## 后续公开分发事项

1. Apple Developer / Developer ID 签名、公证及 Gatekeeper 下载分发验证，待用户开通账号。
2. 在无开发环境的另一台 Mac 做全新安装、首次在线下载模型、HF 许可与钥匙串实际授权验收；当前验证使用已有模型。
3. 降低 FFmpeg 依赖的最低 macOS 版本，并按目标系统重新验证；当前包仅承诺上述系统范围。
4. 公开分发前完成嵌入 FFmpeg 及其组件的许可与对应源码义务。当前包保留版本、组件与许可证说明，不把签名通过视为完成许可审查。
5. 登录自启入口已实现；本轮未修改用户现有登录项，也未注销当前 Mac 验证自动启动。卸载说明保留用户数据，未删除用户资料做演示。

来源参考：[Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)、[Developer ID 与公证](https://developer.apple.com/developer-id/)。
