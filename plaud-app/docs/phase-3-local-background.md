# 第三阶段：纯客户端后台转写

不部署任务服务，不要求 APNs/FCM。继续使用用户自己的 AssemblyAI Key。

## 执行边界

- 默认 FIFO、单条音频上传、最多两条未确认结束的云端任务；提交结果不明也占用名额，绝不自动重复 POST。
- 原生持久化任务日志，密钥独立保存在 Keychain/Android Keystore。Flutter 页面销毁不取消任务。
- Android 用户主动启动 dataSync 前台服务，显示通知，上传、提交及查询均由原生执行。遵守系统超时，停止后保留日志，在用户下次打开时恢复。
- iOS 文件上传和提交使用 background URLSession；查询使用系统安排的 BGAppRefresh 或前台刷新。系统挂起、用户强制退出和后台刷新关闭可能推迟后续排队任务和完成提醒，不承诺即时性。
- 完成结果先保存原生文件，客户端完成既有转写版本事务后才确认清理。异常重启不会重复生成版本或丢弃结果。
- 本地通知仅在本机确认任务完成/失败后发出，拒绝通知权限不影响任务执行。通知不包含录音标题或转写文本。
- 退出/切换账号或更换 Key 后停止旧范围的网络调度，已被云端接受的转写不受影响。恢复原账号/Key 后可继续同步。
- 排队任务允许取消；已提交任务不显示虚假的云端取消。

## 验证

使用合成音频和本地 HTTP 对端检验并发、FIFO、真实二进制上传、后台切换、持久化恢复、未知提交、结果同步、权限拒绝及账号隔离；生产仅允许官方 HTTPS AssemblyAI 地址。模拟器结果不能替代真实手机长时间锁屏、低电量及厂商省电策略验收。

## 官方依据

- [Apple 后台传输](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)
- [Apple 后台调度](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)
- [Android 前台服务超时](https://developer.android.com/develop/background-work/services/fgs/timeout)

iOS 26 的 BGContinuedProcessingTask 适合用户发起且能持续报告实际进度的本机处理；本轮不依赖它维持等待云端结果的空转轮询。
