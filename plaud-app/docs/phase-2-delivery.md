# 第二阶段交付：AssemblyAI 转写与校对

日期：2026-11-07；版本：0.2.0+2；平台：Android / iOS。

## 结论与边界

P1-01～P1-05 功能已实现，达到个人内测版本的预期：配置自己的 Key，确认上传录音，跟踪与恢复远端任务，查看讲话人/时间并回听，校对、保留版本及导出/分享完整来源全文。

60 项 Flutter 测试、Android/iOS 两端的第一阶段回归及第二阶段原生流程全部通过。普通 Android APK 和 iOS Simulator App 以生产入口单独构建、安装并启动，版本号均核对为 0.2.0+2；正式转写设置页面也已实际检查。

**没有提供或使用真实 AssemblyAI Key，本轮没有实际向 AssemblyAI 上传录音、创建付费任务或验收真实识别质量。** API 参数根据当前官方文档实现，网络协议使用合成 AssemblyAI peer 和真实 HTTP 回环服务验证；双端 Keychain/Keystore、播放器与系统分享面板实际运行。生产入口使用正式 HTTPS 客户端，没有演示数据或共享长期 Key。

此前 Web 转写质量验收继续有效。本轮不重新打开该门槛；AssemblyAI 真实识别质量可在填入用户自己的 Key 后，使用明确选择的录音继续验证。

## 使用路径

1. 打开“设置 → AssemblyAI 转写设置”，填写 API Key，选择美国/欧盟区域、语言和模型；保存到系统安全存储。
2. 打开本机导入或已从设备下载的可播放录音，点击“转写此录音”。确认框明确展示录音、提供方、区域、语言、模型与费用归属，再点击“上传并开始转写”。
3. 查看实际上传进度及 queued / processing 状态。App 重开后恢复任务 ID，仅继续查询；完成后保存全文和来源元数据。
4. 点击段落时间回听；校对文字、讲话人归属及人物名称，按需标记已核对。修改另存新版本，旧版本只读预览，可恢复为一个新版本。
5. 导出 Markdown、TXT、JSON、SRT 或 VTT；系统分享提供 Markdown/TXT/JSON 文件，用户自己选择目的地。搜索只影响显示，不截断导出。

API Key 只做本机格式检查，不把“已配置”描述为“远端验证有效”。未配置 Key 不影响账号、蓝牙、本机导入与播放。

## 任务完成情况

| 任务 | 实施结果 |
| --- | --- |
| P1-01 配置与密钥 | 自带 Key；按当前 PLAUD 账号范围/未登录个人范围分别安全保存；Key 与 PLAUD 登录授权隔离；美国/欧盟、自动语言或指定语言、推荐路线或 Universal-2 |
| P1-02 上传与提交 | 上传完整可播放副本，流式读取，保留原件；记录原件哈希、上传副本哈希、参数和 Key 指纹；任务防重；提交前持久化标记 |
| P1-03 恢复与异常 | 已知 ID 只做 GET；网络/429 退避，尊重 Retry-After；后台/账号变更中止本机请求；提交未知不自动重发，允许关联已有 ID |
| P1-04 结果与回听 | 毫秒时间、讲话人、词时间、置信度与实际模型来源；与 Web schema/语义校验互通；缺失时间保留全文，不编造段落；原生播放器跳转回听 |
| P1-05 校对与导出 | 标题沿用本机库；段落文字、讲话人、人物名称及核对状态；不可变历史版本、乐观并发检查；5 种全文导出、3 种原生文件分享 |

推荐模型路线显式提交 `speech_models: ["universal-3-5-pro", "universal-2"]`，服务按语言选取兼容模型；支持选择单独 Universal-2。返回 `speech_model_used` 时记录实际值，缺失时标记 undisclosed，不把请求列表冒充实际模型。[官方模型选择](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model)

上传与转写使用所选区域的相同 API 与 Key，分别调用 `POST /v2/upload`、`POST /v2/transcript`，持久化 ID 后使用 `GET /v2/transcript/{id}`。上传 URL 只用于服务端识别，不作为本机播放器地址。[上传接口](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload)、[提交与参数](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit)、[区域说明](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-region)

## 一致性与数据保留

- 原文件和可播放资产继续由第一阶段库管理；转写状态位于各录音目录的 `transcription/index.json`，每个版本单独保存 `rev_<id>.json`。
- 索引绑定本机录音 ID、来源哈希与账号范围；Key 不进入索引或导出。任务保留发起时的区域、参数、Key 指纹和凭据范围，更换配置不会偷偷使用另一账号/项目的 Key 查询。
- 写文件后原子替换索引；机器结果、人工校对和恢复都保留完整版本。旧基线保存会被拒绝，避免并发修改互相覆盖。
- 修改文字会清空旧词级时间并标记 pending_alignment，原段落时间仍用于定位；改讲话人或人物名称会撤销受影响的旧核对标记。
- 重新转写期间如果出现新校对，迟到机器结果只加入历史，保留当前人工版本，不自动切换或覆盖。
- 提交响应丢失、服务端 5xx 或无法解析 2xx 时记录 uncertain；从控制台取得任务 ID 后进行 GET，验证上传地址相同才关联。也可在核对后结束本机跟踪；这不等于取消云端任务。
- 暂停、退到后台、退出或换账号会停止本机请求；云端已接收的任务仍可能处理和计费。上传中断需重新确认；持久化 uploaded 状态可由用户显式继续提交，不自动执行收费请求。
- 任务提交/查询的 429 时限持久保留；前台恢复后按退避继续安全查询，不盲目重传。
- 更换 Key 后旧任务暂停查询，需要恢复任务原有的 Key、区域和凭据范围；跨项目或轮换 Key 的显式重新授权不在当前内测版本中自动执行。
- 长转写段落按需构建，避免把全部段落变成页面控件；导出始终重新读取所选的已保存完整版本，不依赖搜索结果。

讲话人编号仅在单条录音中有效，自动标注不是实名身份。结果中的时间来自服务端原音频毫秒，回听使用本机音频；此阶段不实施音频裁切或时间重映射。[讲话人接口说明](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers)

## 验证

| 验证 | 结果 |
| --- | --- |
| `flutter analyze --no-pub` | 0 个问题 |
| `flutter test --no-pub` | 60/60；含第一阶段 40 项、第二阶段核心 19 项与长转写页面 1 项 |
| Web/Dart 设备协议对照 | 164/164 |
| 真实文件存储检查 | 14/14 |
| AssemblyAI → Web 转写契约 | 6/6；使用 Web 的 JSON Schema 与语义验证器，覆盖普通、无时间、无模型、重叠和词级回退 |
| Android 14 / API 34 / arm64 | 第一、二阶段原生脚本均通过，合计 2 条完整业务场景 |
| iOS 26.5 / arm64 | 第一、二阶段原生脚本均通过，合计 2 条完整业务场景 |

核心检查包括：无 Key 不发请求、Key 范围隔离、二进制上传及正式区域路由、重复点击防重、queued/processing/completed、重建仅查询、POST 响应丢失/异常不重发、已有任务关联与来源拒绝、401、上传取消、上传中换账号、POST/GET 429、Key 变更、回收站/账号访问、校对版本/词时间失效、旧基线冲突、恢复历史、并发校对保护、未定时全文及所有导出格式。

页面测试以 1000 个段落验证按需构建和全文导出。真实 HTTP 回环测试检查 Authorization、原始二进制请求体和禁止跟随重定向，没有访问第三方服务。

第二阶段原生脚本通过实际页面配置合成 Key、选择 EU/中文、确认前不上传、上传提交、销毁重建 App、只查询原 ID、原生播放跳转、校对另存、保留机器原稿、搜索后完整导出及打开系统分享。iOS 分享面板已通过界面截图实际观察，未选择收件人或发送文件。

“重建”指同一原生进程中销毁/重新创建 App 并重读系统安全存储和磁盘；没有声称完成操作系统杀进程、后台持续传输、真实 Key 计费或真实 BLE 射频验收。保存到系统文件的位置由系统选择器及用户决定，不自动写入第三方云盘。

机器结果：`build/phase2-unit-tests.json`、`build/phase2-android-integration.json`。iOS 因本机 CocoaPods 为隔离安装，使用 Xcode workspace 构建验收入口，再由 `flutter run --no-build --use-application-binary=...` 运行；控制台实测返回 All tests passed。

## 产物与范围

普通启动入口为 `lib/main.dart`；测试模块不会被该入口导入。

- Android：[RecDock-android-0.2.0.apk](../build/deliverables/RecDock-android-0.2.0.apk)，内部 Debug 包。
- iOS Simulator：[RecDock-ios-simulator-0.2.0.zip](../build/deliverables/RecDock-ios-simulator-0.2.0.zip)，不是真机 IPA；真机需要自己的 Apple Team/签名。
- 大小、SHA-256 与包完整性记录：[artifacts-0.2.0.json](../build/deliverables/artifacts-0.2.0.json)。两份 ZIP/APK 完整性与 iOS 可执行权限已检查。

本轮没有配置服务端代理、产品付费账号、App Store 发布、后台常驻任务、远端任务删除/取消、ChatGPT 自动提交或跨设备同步。面向多用户正式分发时，可在现有客户端边界上增加服务端代理和用量控制；当前自带 Key 的内测路径已完整实现。
