# 第一阶段交付记录

日期：2026-11-07；版本：0.1.0+1；平台：Android / iOS。

此为第一阶段历史记录。后续 0.2.0 已完成双端第一阶段回归，新产物见[第二阶段交付](phase-2-delivery.md)；本页非版本化 build 路径可能被后续构建覆盖。

## 结论

第一阶段功能实现与双端模拟器验收完成，达到本轮可在开发环境验证的预期：登录账号、匹配已有绑定设备、认证后读取状态/目录、流式下载设备录音、解密保留原件、入库及原生播放，离线重建后仍可播放。

用户本轮允许使用模拟器。模拟器中的云端账号和 BLE 设备由测试专用 peer 提供，执行与生产一致的密码加密、RSA/ChaCha 握手、状态/目录报文及文件传输逻辑；Keystore / Keychain、真实磁盘和原生播放器实际运行。**物理 BLE 射频连接、真实 PLAUD 账号云端现场登录和具体固件覆盖未在 App 上实测，不记为通过。** Web 既有真实设备验收仍然有效，但不代替这些移动端覆盖。

本轮没有调用 AssemblyAI，没有音频上传、转写或付费请求。AssemblyAI 是下一阶段范围。

## 已交付行为

| 范围 | 结果 |
| --- | --- |
| PLAUD 登录 | 邮箱密码登录、兼容密码加密与 Fernet 响应、官方区域白名单、身份校验、绑定设备列表、错误提示 |
| 会话 | token 成对轮换、并发刷新合并、旧异步操作失效、安全持久化、退出与账号范围切换 |
| 原生安全存储 | Android Keystore AES/GCM 保护的存储；iOS Keychain，AfterFirstUnlockThisDeviceOnly；密码不持久化 |
| 设备连接 | 广播 SN 匹配绑定 SN，GATT 服务/特征检查、MTU、通知收件箱、传统与协议 20 认证、单次解密和重放保护 |
| 状态/目录 | 认证和实际状态返回后才标记连接；电量、存储、录音状态/事件/时长；完整目录聚合与重复/缺口检查；断连清状态 |
| 下载 | 单任务流式写磁盘、空间/大小检查、连续偏移与重叠内容检查、超时/缺口恢复、停止确认、取消及同次运行内继续 |
| 录音保护 | 设备录音开始时暂停文件同步；不主动终止录音；离开前台暂停扫描、下载和播放 |
| 音频 | PLAUD.AI / RSA 内容密钥 / ChaCha 流式恢复；原件保留；Ogg CRC/页序/结束检查；已确认的原始 Opus 封装 |
| 本机库 | v1/v2 索引兼容，账号/设备/session/源哈希隔离去重；原件与播放资产分别保存；重新恢复音频时保留原编号和标题 |
| 播放 | Android Ogg/Opus；iOS 按需流式生成 CAF/Opus 缓存；播放/暂停、时长和拖动；离线重建及退出隐藏账号录音 |

不依赖运行中的 Web、Mac 本地服务或本地转写模型。个人本机导入、搜索、改名、回收站和恢复继续可用。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `flutter analyze --no-pub` | 通过，0 个问题 |
| `flutter test --no-pub --reporter expanded --file-reporter json:build/phase1-unit-tests.json` | 40 项全部通过；机器报告在 `build/phase1-unit-tests.json` |
| Web/Dart 协议同批对照 | 164/164，通过；直接执行两份源码 |
| 真实文件存储检查 | 14/14，通过 |
| Android APK | `flutter build apk --debug --no-pub` 成功；模拟器安装、普通启动成功 |
| iOS Simulator App | Xcode workspace Debug 构建成功；模拟器安装、普通启动与正式登录页面检查成功 |
| Android 完整模拟器脚本 | Pixel 6，Android 14 / API 34，arm64；1 条完整业务场景通过 |
| iOS 完整模拟器脚本 | iPhone 17 Pro，iOS 26.5，arm64；同一条完整业务场景通过 |

模拟器脚本为 [`integration_test/phase1_test.dart`](../integration_test/phase1_test.dart)，实际覆盖：

1. 原生安全存储写入、读取，并使用独立 `smoke_` 命名空间。
2. 在实际 App 页面输入合成账号密码，完成密码加密、绑定设备加载与设备扫描匹配。
3. 协议 20 RSA 握手和会话加密，读取电量 66%、存储、录音状态及目录。
4. 下载合成加密 PLAUD.AI 文件，恢复 Ogg、保存原件和播放副本，打开录音详情。
5. 原生播放器播放，进度实际前进，拖动跳转成功；iOS 在此过程中验证 CAF 播放缓存。
6. 销毁并重新创建 App，复用原生凭据和磁盘录音，以断网 transport 恢复会话，再次播放。
7. 退出账号后库中账号录音不可见，磁盘原件继续保留；测试结束仅清理专用数据。

这一步的“重启”是同一原生进程内完整销毁/重建 App 状态并重读原生凭据与磁盘；没有声称系统杀进程、后台传输或手机断电恢复经过验收。

核心回归另覆盖：独立 Node/Web 密码学字节对照、篡改/重放拒绝、SN 不匹配、错误密码、并发刷新、迟到登录不复活、离线时限/401/身份不匹配、取消和重连继续、录音事件暂停文件同步、Ogg 损坏、独立 CAF 转换器元数据对照、账号访问隔离和原件补回播放资产去重。窄屏/大字体页面测试通过。

## 产物与运行

- Android：[app-debug.apk](../build/app/outputs/flutter-apk/app-debug.apk)。包名 `ai.audiobridge.plaud_app`，内部 Debug 包。
- iOS Simulator：[压缩包](../build/deliverables/RecDock-ios-simulator-0.1.0.zip)，解压为 `Runner.app`；原路径 `build/ios-phase1/Build/Products/Debug-iphonesimulator/Runner.app`，Bundle ID `ai.audiobridge.plaudApp`。仅供模拟器，真机需自己的 Team/签名。
- 包大小与 SHA-256 校验值：`build/deliverables/artifacts.json`；压缩包完整性和执行权限已检查。
- 测试入口、协议 peer 和合成材料全部位于 `test/` / `integration_test/`，生产 `lib/main.dart` 不导入这些文件，也没有演示开关。

常规开发环境：

```sh
flutter pub get
flutter analyze
flutter test
flutter test integration_test/phase1_test.dart -d <device-id>
flutter build apk --debug
flutter build ios --simulator --debug
```

本机使用 Flutter 3.27.5-ohos-1.0.4 / Dart 3.6.2、Xcode 26.6、CocoaPods 1.16.2、AGP 8.7.3 / Gradle 8.13。CocoaPods 安装在隔离的临时工具目录，官方依赖缓存预热后，最终以普通 `pod install --no-repo-update` 生成 trunk 锁文件；工程不包含临时 checkout 路径。

本机 Flutter 命令无法自动找到隔离安装的 CocoaPods，因此 iOS 采用 `xcodebuild` 构建，再用 `flutter run --no-build --use-application-binary=<Runner.app> --target=integration_test/phase1_test.dart` 执行相同验收入口；控制台实际返回 `All tests passed!`。普通 App 用 `FLUTTER_TARGET=lib/main.dart` 单独构建、安装和启动，没有把测试包作为产品包交付。

iOS 已修复 Swift 蓝牙插件静态 Framework 集成及 Keychain entitlement。模拟器也需要保留 Xcode 模拟签名；完全无签名的包不能证明 Keychain 可用，相关签名权限要求参见 [Apple Keychain entitlement 说明](https://developer.apple.com/documentation/security/errsecmissingentitlement)。CocoaPods Profile 配置提示和依赖旧 API 的编译警告仍存在，当前 Debug 原生构建/运行通过，未执行 App Store 发布构建。

## 明确边界

- 支持目标传统协议和协议 20；协议 30 自动 ECC、新设备绑定/解绑、录音控制、设备文件删除、OTA、Wi-Fi 不在第一阶段。
- 完整录音持久保存；部分下载只承诺同次运行、同账号/SN/协议/session/大小继续，杀进程后的持久续传另行实现。单条设备文件上限 256 MiB。
- 前台下载和播放；后台系统挂起不承诺继续。App 退出登录不会删除录音或历史 RSA 材料，卸载会清除本机音频。
- 最近七天内在线校验的会话，遇网络失败可离线读本机录音；离线禁止设备授权。401、身份不匹配、未来/超期时间或未验证会话不离线恢复。
- 未知格式、缺少历史密钥、解密或容器失败时保留原件，不伪造可播放状态；原始文件尾的未确认 CRC 算法没有宣称已验证。

下一阶段按既定 P1-01～P1-05 接入 AssemblyAI：先确定 Key 归属和服务端代理/个人自带 Key，再完成用户主动上传、提交、状态恢复、结果与时间回听、校对和导出。
