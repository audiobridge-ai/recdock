# RecDock 桌面工作台

独立 Mac 窗口内完成录音导入、处理、回听、校对和导出。当前版本 `1.0.0-rc.2` 为未公证候选版，本机核心流程已通过；干净 Mac 首次安装和桌面设备真机回归仍待补齐。模型继续使用既有固定修订，不包含在 App 安装包中。

## 当前支持范围

- Apple Silicon，macOS 26.2 及以上。当前 MLX 等原生组件决定系统下限；Intel、Windows 和较旧 macOS 尚未验收。
- App 自带 Electron、Node、Python、FFmpeg 和处理依赖，使用者无需安装 Homebrew 或开发工具。
- 模型约 3.78 GB；请至少预留 10 GB，另为录音和处理临时文件保留空间。安装包大小以最终构建清单为准。
- 首次模型下载需要联网，并由用户自行完成 pyannote 模型访问授权。准备完成后的本地处理不需要下载令牌。
- 一键发送到 ChatGPT 需要 Edge、RecDock 扩展和用户已登录的 ChatGPT 页面。不需要 OpenAI API Key。

## 安装与首次使用

安装包与校验值以本仓库 Release 附件为准，选择 `macos-arm64` 并核对同版本 SHA-256。候选版安装 ZIP 约 486 MB，App 展开约 1.495 GB；模型另行准备。

1. 退出旧 RecDock 助手，等待任务停止。打开 DMG，将 RecDock 拖入“应用程序”；ZIP 则先完整解压再移动 App。
2. 打开 RecDock。本候选版使用本地 ad-hoc 签名，**没有 Developer ID 和 Apple 公证**。若系统提示无法验证开发者，确认来源和校验值后，由你在“系统设置 → 隐私与安全性”中选择该 App 的“仍要打开”。具体可用操作取决于系统与设备管理策略。[Apple 官方说明](https://support.apple.com/zh-cn/102445)
3. 若显示“已损坏”、签名校验失败或保护软件终止进程，保留提示并反馈；重新核对文件完整性。公司管理设备需要遵循管理员策略。
4. 在“模型与应用”中选择已有 RecDock 模型目录，或打开模型许可页面、自行授权后保存下载令牌，再下载、完整校验并检查环境。
5. 导入测试音频，选择“导入并转写”，或先“仅导入音频”再开始处理。

模型下载令牌使用 macOS 钥匙串支持的加密机制保存。拒绝钥匙串请求后，已有完整模型仍可使用；仅保存或读取已存下载令牌会需要该授权。状态查询不读取钥匙串。应用不使用下载令牌调用转写模型，不向项目维护者发送令牌。

## 一键发送到 ChatGPT

在“模型与应用”中复制浏览器扩展目录，在 Edge 的 `edge://extensions/` 启用开发人员模式并“加载解压缩的扩展”。首次安装需要你允许 Native Messaging 权限。只保留一个 RecDock 扩展启用，更新 App 后在扩展页重新加载。

打开并登录 ChatGPT，然后在 RecDock“设置”中“连接现有 ChatGPT 页面”。录音详情的发送按钮发送当前已保存版本的**完整 Markdown 转写和提示词**，不会上传音频。你可以先导出检查全文。发送上限为 8 MiB；搜索、讲话人筛选和分页不会截断附件。

已有草稿或附件时停止自动操作；提交结果未知时只核对状态，不自动重发。已确认提交的同一版本再次点击会打开原对话。ChatGPT 页面、登录状态和配额变化可能影响转发，可以导出完整 Markdown 手动上传。

## 数据、升级与退出

资料位于 `~/Library/Application Support/RecDock`，已有模型目录选择保持不变。关闭窗口后任务继续；明确退出停止处理，重开恢复尚未完成的任务。不要同时运行旧助手和桌面版。替换 App 不会删除录音、修订和模型；重要资料应另行备份。

“打开资料目录”可查看本机文件。`desktop/startup-status.json` 记录最近启动失败；“检查环境”后 `desktop/environment-status.json` 记录工具退出码与 GPU 检查。诊断保存在本机，反馈问题前自行检查内容；无需提供录音、账号缓存或下载令牌。

## 开发与构建

先按 [旧助手构建说明](../companion-macos/README.md) 准备自带运行时，安装 `plaud-web` 的锁定依赖，再安装桌面依赖：

```sh
cd desktop
npm ci
npm test
cd ..
python3 desktop/scripts/build_icons.py
```

从官方固定源码构建无外部编解码库的 FFmpeg 8.0.1，脚本核验下载文件哈希并记录构建参数：

```sh
curl -fL https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.0.1.tar.gz -o /tmp/recdock-ffmpeg-n8.0.1.tar.gz
python3 desktop/scripts/build_audio_tools.py --source /tmp/recdock-ffmpeg-n8.0.1.tar.gz --output desktop/vendor/audio-tools
```

打包时传入已验证运行时、官方 Electron 45.3.1 ARM64 ZIP，以及上一步共享音频工具：

```sh
python3 desktop/scripts/build_macos.py --runtime-app /path/to/verified/RecDock.app --electron-zip /path/to/electron-v45.3.1-darwin-arm64.zip --audio-tools desktop/vendor/audio-tools --output desktop/dist/rc-build --archive --dmg
```

使用新的输出目录；脚本拒绝覆盖既有构建。官方 Electron SHA-256 固定在构建脚本中。默认 ad-hoc 签名，不执行公证，也不把本地签名表述为 Apple 认证。最终大小、原生组件实际系统下限和附件 SHA-256 写入 `build-result.json`。

普通源码联调通过固定 Electron 开发入口完成，避免每次修改源码都重签运行时：

```sh
python3 desktop/scripts/prepare_dev.py --resources /path/to/RecDock.app/Contents/Resources
```

然后打开生成的 `desktop/vendor/RecDock Dev.app`。只有显式 `--refresh-launcher` 才重建启动器。首次准备需要已有 Electron SDK，或传入经过核验的 `--electron-zip`。

自有代码采用 [MIT](../LICENSE)。模型、Chromium/Electron、Python 包和 FFmpeg 各自保留上游许可；包内 `Contents/Resources/Licenses` 提供声明与 FFmpeg 对应源码及重建入口。模型不随源码仓库或安装包再分发。
