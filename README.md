# RecDock

RecDock 是免费开源的本地录音工作台，用于录音导入、转写、时间回听、校对和全文导出。本仓库维护独立 Mac 桌面版、共用 Web 代码与 Android / iOS 客户端。

RecDock 为独立客户端，与 PLAUD 官方无关联，也未获得其背书。两端的设备支持、转写方式和验证范围以各自说明为准。

后续产品、开源发布与能力展示方向见[桌面产品与开源展示方案](docs/desktop-product-plan-2026-11-12.md)：优先交付独立 Mac App，后续适配 Windows，官网承担展示、下载与合作联系。

## 项目入口

| 目录 | 内容 | 开发说明 |
| --- | --- | --- |
| [`desktop/`](desktop/) | 独立 Mac 录音工作台、模型准备与 ChatGPT 扩展桥接；当前为未公证候选版 | [桌面安装与构建说明](desktop/README.md) |
| [`website/`](website/) | 产品展示、系统要求、下载说明和合作入口 | [官网源码说明](website/README.md) |
| [`plaud-web/`](plaud-web/) | TypeScript / Vite Web 工作台、Node 本地服务、Python 本地转写 Worker 与可选 Edge 扩展 | [Web README](plaud-web/README.md) |
| [`plaud-app/`](plaud-app/) | Flutter Android / iOS App、原生蓝牙与后台转写桥接，支持自带 AssemblyAI Key | [App README](plaud-app/README.md) |
| [`companion-macos/`](companion-macos/) | 自带本地运行时的 Mac 菜单栏助手、网站授权与模型准备 | [Mac 助手说明](companion-macos/README.md) |
| [`docs/`](docs/) | 仓库组织、共用协议入口与跨端校验说明 | [仓库开发说明](docs/repository-layout.md) |

## 启动 Web

Mac 桌面候选版支持 Apple Silicon 与 macOS 26.2 及以上，见[安装与模型准备说明](desktop/README.md)及[本轮验收记录](docs/reports/desktop-rc-progress-2026-11-12.md)。旧的[网站与本地助手实现](plaud-web/docs/reports/macos-companion-stage2-2026-11-11.md)保留。下方是 Web 源码开发入口。

需要 Node.js 22.18 或更高版本。完整设备与本地转写流程目前面向 macOS，模型与 FFmpeg 准备见 [Web 开发说明](plaud-web/docs/development.md)。

```sh
git clone https://github.com/audiobridge-ai/recdock.git
cd recdock/plaud-web
npm ci
npm run dev
```

打开 <http://localhost:5173/>，并保持本地服务运行。

## 启动 App

在同一份 checkout 中，需要 Flutter 3.27 或更高版本、Dart 3.6.2 或更高版本，以及对应平台工具链。Android 需要 JDK 17 和 Android SDK；iOS 需要 macOS、Xcode 和 CocoaPods。

```sh
cd recdock/plaud-app
flutter pub get
flutter run -d <device-id>
```

真机签名、后台执行边界和设备验证范围见 [App README](plaud-app/README.md)。

## 校验

以下命令在仓库根目录运行。先分别安装 Web 与 App 依赖。

```sh
npm --prefix plaud-web test
npm --prefix plaud-web run build

cd plaud-app
flutter analyze
flutter test
node --experimental-strip-types tool/verify_protocol_parity.mjs
node --experimental-strip-types tool/verify_transcript_contract.mjs
dart tool/verify_storage.dart
```

协议与转写契约校验会直接读取同仓 Web 源码；需要 Node.js 和 Dart，`RECDOCK_DART` 可指定 Node 校验脚本使用的 Dart 路径。两端分别维护依赖和发版，可使用 `web-v…` 与 `app-v…` 标签。

本次目录整理的检查结果见 [2026-11-09 迁移记录](docs/reports/monorepo-2026-11-09.md)。

## 许可证

[MIT](LICENSE)。模型及其他第三方资源的说明见 [Worker 模型声明](plaud-web/worker/MODEL-NOTICES.md)。
