# RecDock App

本工程位于 [RecDock 仓库](../README.md)的 `plaud-app/`，与 [`plaud-web/`](../plaud-web/README.md) 同级维护。本文的 Flutter、Dart 与 Node 工具命令均在 `plaud-app/` 执行。

RecDock 的 Android / iOS 客户端，沿用已验收的 plaud-web 产品能力，采用 Flutter 共享双端代码。当前版本为 0.3.0，已加入 AssemblyAI 转写、回听、校对、历史版本、全文导出与纯客户端后台任务队列。

已接入：本机音频导入、原件保存与 SHA-256 去重、搜索、播放/跳转、标题修改、回收站与恢复、前台蓝牙扫描和 PLAUD 广播识别。录音持久化不依赖账号，导入不自动发起转写。

已实现 **PLAUD 账号登录 → 已绑定设备匹配与认证 → 状态和录音目录 → 流式下载、解密和本机播放**，以及账号隔离、离线重启播放与同次运行内的下载继续。设备链路记录见[第一阶段交付](docs/phase-1-delivery.md)；转写能力与验证边界见[第二阶段交付](docs/phase-2-delivery.md)。

在“设置 → AssemblyAI 转写设置”中保存自己的 Key、区域和语言，打开可播放录音后主动点击转写并确认上传。支持讲话人、段落时间回听、文字/人物校对、只读历史预览与恢复、Markdown/TXT/JSON/SRT/VTT 全文导出及系统分享。没有产品共享 Key，也不会因为导入或登录就自动上传。

模拟器验收使用测试专用云端/设备 peer，原生 Keychain / Keystore 和播放器真实运行。实际 PLAUD 云端账号与物理 BLE 连接尚未在 App 上现场实测，不能由模拟器结果推定。

## 开发

使用 Flutter SDK（Dart >= 3.6.2、Flutter >= 3.27）、Android SDK、JDK 17；iOS 还需要 Xcode 和 CocoaPods。最低系统为 Android API 23、iOS 14。工程使用 AGP 8.7.3 / Gradle 8.13 / NDK 27.0.12077973。

```sh
flutter pub get
flutter analyze
flutter test
flutter run -d <device-id>
```

```sh
flutter build apk --debug
flutter build ios --simulator --debug
```

iPhone 真机安装需要本机开发者签名；未配置发布证书或发布流程。

iOS 使用静态 Framework 集成 Swift 蓝牙插件，Keychain entitlement 按 App 自身 Bundle ID 配置。模拟器运行也应保留 Xcode 的模拟签名和 entitlement；不要用完全无签名的包验证 Keychain。`Podfile.lock` 使用常规 CocoaPods trunk 依赖，不依赖临时 checkout。

## 核心校验

以下命令在 `plaud-app/` 执行，不启动测试服务器；协议校验需要同仓同级 `plaud-web/` 和支持 TypeScript strip-types 的 Node.js。首次运行前分别执行 Web 的 `npm ci` 和 App 的 `flutter pub get`。

```sh
node --experimental-strip-types tool/verify_protocol_parity.mjs
node --experimental-strip-types tool/verify_transcript_contract.mjs
dart tool/verify_storage.dart
```

`RECDOCK_DART` 可指定协议校验使用的 Dart 可执行文件。协议对照直接执行 Web 与 Dart 源码，比较同批 164 组报文；存储校验在临时目录使用真实文件。

当前已通过静态检查、67 项 Flutter 测试、164 组协议对照、14 项存储检查和 6 组 Web 转写契约校验。原生脚本位于 `integration_test/phase1_test.dart` 、`phase2_test.dart` 和 `phase3_test.dart`，覆盖设备下载播放、Key 设置、显式转写、任务恢复、回听、校对与原生分享。测试账号、Key、音频与服务端结果均为合成材料，生产入口不导入测试模块，正式 App 没有演示开关。

## 数据与权限

音频和转写版本保存在 App 的 Application Support 专属目录；回收站支持恢复。卸载会清除本机资料。只有用户确认转写才向 AssemblyAI 上传可播放副本，费用由该 Key 的项目承担；原件仍在本机。Key 按账号范围通过系统安全存储保护，不写入任务索引或导出文件。没有请求麦克风和广泛文件存储权限。文件选择由系统选择器授权；蓝牙权限在点击扫描时请求。Android 11 及以前需要位置权限和定位服务，Android 12+ 使用附近设备权限。

App 使用持久 FIFO 队列：每次上传一条，最多两条未确认结束的云端任务。已批准但尚未上传的任务可在原范围恢复；提交响应丢失时标记待确认，绝不自动重复收费 POST。Android 通过带通知的原生前台服务上传、提交及查询；iOS 使用系统后台上传和机会性刷新，不能保证挂起时的即时查询或完成提醒。无需公网服务、APNs 或 FCM，本地通知需要系统授权。具体边界见[第三阶段交付](docs/phase-3-delivery.md)。历史原稿与人工校对分版本保存；修改文字会移除已过期的词级时间。

播放失败时保留原件并提示。设备 Opus/Ogg 在 Android 直接播放，iOS 按需流式生成 CAF/Opus 缓存，不全量加载长音频或生成巨大 PCM 文件。前台扫描匹配账号绑定 SN，经认证和实际状态请求成功后才显示已连接。支持传统和协议 20；协议 30 自动认证属于后续扩展。

已在线验证的会话遇网络错误时，七天内允许离线读取本机录音；离线禁止设备授权。401、账号不匹配、未验证或超期会话不能离线恢复。当前仅承诺前台下载/播放，离开前台会暂停；杀进程后的持久续传另行安排。

RecDock 为独立客户端，与 PLAUD 官方无关联。

参考：[Flutter 双端开发](https://docs.flutter.dev/platform-integration)、[BLE 插件说明](https://pub.dev/packages/flutter_reactive_ble/versions/5.3.1)、[Web 验收结论](../plaud-web/docs/reports/feature-readiness-2026-11-07.md)。
