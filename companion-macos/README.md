# RecDock Mac 本地助手

阶段目标：Apple Silicon Mac 上无需终端，安装助手、授权网页、准备模型并完成本地转写。

本轮用户已确认先交付本地可测试版本。Developer ID 签名、公证和公开分发待开发者账号开通后完成，ad-hoc 安装包仅用于本地测试。

实现约束：

- AppKit 菜单栏 App 管理用户级 Node 服务；关闭窗口或网页不停止任务，明确退出助手才停止服务。
- Node、Python、生产依赖、FFmpeg/FFprobe 和原生辅助程序随 App 打包；运行时不依赖 Homebrew、Xcode 或源码目录。
- 录音、模型、配置与授权放在用户 Application Support，不写入 App bundle；默认不移动既有资料。
- 固定 HTTPS 工作台来源；网页用 PKCE 请求授权，用户在本机窗口确认。仅持久化访问令牌的摘要，可查看和撤销授权。配对码保留为备用入口。
- 开机启动使用 SMAppService，由用户在界面选择。
- 模型采用现有固定版本与完整性校验；需 Hugging Face 许可的模型提供官方授权入口，不代替用户接受条款。
- 公网签名版必须通过 Developer ID、Hardened Runtime、公证和分发验收；本地 ad-hoc 包不冒充签名分发版。

验收必须区分自动检查、真实 GPU 推理、浏览器与本机授权、干净 Mac 安装，以及公开分发资格。任一尚未完成时，在报告中列出，不以模拟代替。

## 本地测试构建

在已准备好原项目依赖、独立 Python 3.11 和模型依赖的 Apple Silicon Mac 上运行：

```sh
python3 scripts/build.py --output dist/local-test
```

构建脚本生成自带运行时的 `RecDock.app` 和 ZIP。目标机器不需要 Node、Python、Homebrew 或 Xcode；模型不打入安装包，可在助手中选择已有目录或下载。动态库决定最低 macOS 版本，具体值写在 `build-result.json` 中。当前测试机的 FFmpeg 依赖要求 macOS 26.2。

新构建使用新的输出目录，不覆盖已有安装包。公开签名版可通过 `--identity 'Developer ID Application: …' --notary-profile <已在钥匙串配置的名称>` 启用签名和公证。公开分发前仍需完成第三方组件对应源码与许可义务、较低系统版本兼容性和干净 Mac 验收。

录音、授权和设置默认保存在 `~/Library/Application Support/RecDock`，不随 App 升级或移除自动删除。源码版原有录音保留在原位置。关闭登录后自动启动并退出助手后，可以移除 App；资料目录由用户自行保留或管理。
