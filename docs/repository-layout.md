# 仓库组织与跨端开发

## 目录与命令范围

```text
recdock/
├── README.md
├── LICENSE
├── docs/                     # 仓库共用说明与跨端资料入口
├── plaud-web/
│   ├── src/                  # Web 界面与 TypeScript 协议实现
│   ├── server/               # 本地 API、认证与录音服务
│   ├── contracts/            # 音频 JSON Schema 与合成契约样例
│   ├── worker/               # Python 本地转写
│   ├── extensions/           # 可选 Edge 扩展
│   └── docs/                 # Web 专属设计、开发与历史报告
└── plaud-app/
    ├── lib/                  # Flutter 界面、领域逻辑与 Dart 协议实现
    ├── android/              # Android 原生工程
    ├── ios/                  # iOS 原生工程
    ├── test/                 # Flutter 测试与合成样例
    ├── integration_test/     # 平台集成验收入口
    ├── tool/                 # 跨端协议、契约和存储校验
    └── docs/                 # App 专属方案与交付记录
```

Web 的 npm 命令、Python Worker 命令在 `plaud-web/` 执行；Flutter、Dart 和 App 工具命令在 `plaud-app/` 执行。仓库根目录不创建额外的 npm 或 Flutter workspace。两端各自保留锁文件，独立构建与发布。

## 共用协议与契约

- [设备协议说明](../plaud-web/docs/protocol.md)：两端设备协议迁移和实现的参考。
- [录音与转写数据契约](../plaud-web/docs/audio-contracts.md)：音频对象、时间与版本语义。
- [音频 JSON Schema](../plaud-web/contracts/audio-v1.schema.json) 和 [合成样例](../plaud-web/contracts/fixtures/)：现有 Node / Python 校验器读取的位置。
- [App 协议对照](../plaud-app/tool/verify_protocol_parity.mjs)：对同批报文执行真实 TypeScript 和 Dart 实现。
- [App 转写契约对照](../plaud-app/tool/verify_transcript_contract.mjs)：用 Web 校验器验证 App 生成的转写对象。

协议和契约暂时保留在 Web 已有路径，避免改变运行时加载位置。修改协议、字段或时间语义时，同一提交中更新相关实现与样例，并执行跨端校验。界面和平台实现仍分别维护。

## 本地数据与迁移

此次调整将原 Web 仓库内容移至 `plaud-web/`，并将 Flutter 工程纳入 `plaud-app/`，保留原 Web Git 历史。历史阶段报告保留在对应项目中；早期报告的仓库根路径应按当时目录理解。

Web 默认录音库现在位于 `plaud-web/.local-audio/library/`；本机已有 `.local-audio/` 随 Web 目录一起移动，仍由忽略规则排除。`RECDOCK_LIBRARY_DIR` 显式配置的外部目录由开发者按实际路径维护。macOS 用户缓存和手机 App 沙盒目录不受仓库重组影响。

新 checkout 运行 `npm ci`、`flutter pub get` 恢复依赖；iOS 使用 `ios/Runner.xcworkspace`。移动本机 checkout 后也应重新运行 `flutter pub get`，刷新包含绝对路径的生成配置。Pods、SDK 路径、签名私钥、用户缓存、音频、模型和构建包均不入库。测试中的合成协议材料用于离线验证，不是用户账号或真实录音。

## 验证与发版

- Web 变更：在 `plaud-web/` 运行 `npm test`、`npm run build`；Worker 变更按 Web 开发说明运行 Python 测试。
- App 变更：在 `plaud-app/` 运行 `flutter analyze`、`flutter test`，涉及原生桥接时补充对应平台构建和集成验证。
- 协议与数据契约变更：在 `plaud-app/` 运行两个 Node 对照脚本；存储变更运行 `dart tool/verify_storage.dart`。
- 两端可独立发版，建议标签前缀为 `web-v`、`app-v`。后续 CI 可按目录选择任务；协议和契约修改需同时覆盖跨端校验。
