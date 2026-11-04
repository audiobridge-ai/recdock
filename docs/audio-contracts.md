# 本地录音数据与 Worker 协议 v1

状态：录音库、持久队列、正式 Worker 与校对页面已实现；本机模型已实测，人工质量 G0 尚未通过。Sync 仍为预留契约，ChatGPT 发送本轮不实施。契约使用 `contracts/audio-v1.schema.json`，前端类型位于 `src/library/types.ts`，Node/Python 校验器读取同一 schema。

## 数据对象

| 对象 | 内容 | 关键语义 |
| --- | --- | --- |
| Recording | 来源、资料范围、原件和可播放资产 | 服务端分配 ID；源哈希去重；媒体路径只允许受管目录下的相对路径 |
| Transcript | 机器全文或校对版本的物化快照 | 时间为原始音频毫秒；包含人物、片段、词、原始人物 turns 和来源 chunks |
| Job | 展示任务状态、阶段、已完成阶段、错误 | 不是队列内部存储的全部字段；运行时必须有 stage，终态 stage 为 null |
| Revision | 基于某个 revision 的人工改动 | 修改姓名与文字分别表达；文字修改需清除失效词时间并等待局部重对齐 |
| Sync | 指定全文版本向某个目标的发送记录 | prepared、attached、submitted、verified 分别记录；提交不代表持久化或 Memory 已更新 |
| WorkerCommand | Node 发给 Python 的 run/cancel | 资产通过受管 ID 引用；不开放消息内任意本机路径读取 |
| WorkerEvent | Python 发给 Node 的阶段事件 | 原始模型输出先写资产，事件只返回资产相对路径与哈希 |

示例只使用合成文字，见 `contracts/fixtures/transcript-v1.json`。不能把示例中的人物或时间当成模型测试结果。

## 时间、人物与校对规则

所有时间区间为 `[startMs, endMs)`，满足 `0 ≤ startMs < endMs ≤ durationMs`。片段按开始时间排序；允许重叠，不强制结束时间递增。词的时间必须在所属片段内。

无法对齐的词使用 `startMs: null`、`endMs: null`、`timingSource: unavailable`。粗粒度句级时间与 forced alignment 分别标注。人工文字改动使用 `user_pending`，不得继续携带旧词级时间。

`speakerId: null` 表示归属不确定；非空 ID 必须引用当前录音的人物表。默认编号只在当前录音内稳定，显示姓名仅由用户确认。保留模型原始输出；正式稿允许对不超过 40 毫秒的端点越界作边界裁切，受影响段落标记讲话人待核对，更大的越界仍拒绝。保留可重叠的人物 turns，不从 exclusive 投影推导没有重叠。

每个片段引用一个或多个 `sourceChunkIds`。校验器检查引用存在，并检查片段时间处于这些 chunk 及其 padding 的连续覆盖内，用于拦截分块 offset 还原错误。整个音频是否遗漏语音需要处理流水线和基准另外验证，schema 校验不能证明语音识别完整。

模型分数保留 engine、kind、原始 value。未提供分数时为 null；不混合 log probability、声学打分等不同指标生成统一置信度。

## 进程消息

通信采用 UTF-8 JSONL，每行一个 JSON 对象，发送端使用 JSON 编码转义文字内的换行。单行上限设为 1 MiB，由 T06 的流读取器在累积数据时执行限制。stdout 专用于协议，stderr 用于脱敏诊断。

| 事件 | stage | payload |
| --- | --- | --- |
| ready | null | workerVersion、支持的阶段列表；jobId 为 null |
| stage_started | 当前阶段 | 本阶段输入指纹 |
| progress | 当前阶段 | completedUnits、totalUnits 或 null、unit；不能超过已知总量 |
| artifact | 当前阶段 | kind、受管相对路径、SHA-256 |
| completed | null | 全文结果相对路径与哈希 |
| failed | null | code、用户可读 message、retryable |
| cancelled | null | user / logout / shutdown |
| heartbeat | null | 当前任务运行时长 |

每个 Worker 进程的事件 sequence 从 ready 的 1 开始逐条增加；后续 jobId 必须匹配该进程被分配的任务。重复、缺失或倒退序号、未准备完成就发结果、错误任务 ID 由 T06 管理器拒绝。正式队列与进程管理器同时执行这些静态及生命周期校验。

`run` 包含 recordingId、sourceAssetId、pipelineFingerprint、language 和可选的人数上下界。Node 在启动进程时提供受管任务根目录，Python 在根目录内解析资产 ID；原始私钥和账号 token 不进入协议。

## 状态与缓存

Job 状态为 queued、running、succeeded、failed、cancelled、interrupted、paused。准备、转写、对齐、人物区分、合并、导出属于 stage，独立于 Job 状态。只有 failed 持有对外错误信息；恢复后旧任务保留历史，新尝试使用新 job ID，可复用已提交阶段缓存。

| 变化 | 需要重算 |
| --- | --- |
| 源文件变化 | 生成新输入，所有阶段 |
| 解码/VAD/分块参数变化 | 预处理和所有下游 |
| ASR 模型、revision 或文字变化 | 受影响的转写/对齐/合并；人工改文字无需重新 ASR |
| 对齐模型或参数变化 | 对齐、合并、导出 |
| 人物区分模型或人数提示变化 | 人物区分、合并、导出 |
| 人物显示姓名变化 | 生成新校对版本和导出，不重新推理 |
| 导出格式变化 | 只生成该格式派生文件 |

阶段缓存由完整输入指纹和已校验产物确定，不单靠输出文件存在。中断阶段不算已提交；重启后重新执行。Sync 绑定具体 revision 和导出哈希，旧同步结果不能变成新版 verified。

## 错误码与验证

已实现的契约错误统一为 `AUDIO_CONTRACT_INVALID`，错误信息不包含被拒绝的全文实例。后续环境与处理错误至少区分 `MODEL_MISSING`、`HF_LOGIN_REQUIRED`、`MLX_DEVICE_UNAVAILABLE`、`UNSUPPORTED_AUDIO`、`SOURCE_INCOMPLETE`、`DECODE_FAILED`、`ALIGNMENT_FAILED`、`DIARIZATION_FAILED`、`DISK_FULL`、`WORKER_PROTOCOL_INVALID`、`SCOPE_DENIED`、`REVISION_CONFLICT`；具体 HTTP 映射在相应服务任务实现时增加。

Node 和 Python 共同消费 `contracts/fixtures/contract-cases.json` 中的 29 个案例，覆盖未知人物、重叠、空时间、接缝归属、来源时间越界、错误状态和协议 payload。两端通过同一案例只能证明契约一致，不能代替模型准确率和实际进程生命周期测试。

## 主动触发与落盘

入库提交的 `transcribe` 布尔值为显式用户意图，只有 `true` 才排队；省略或 `false` 仅保存。已保存录音通过 jobs 接口单独开始或重试，恢复用户已启动的中断任务不属于新的自动转写。

默认媒体根目录是项目内 `.local-audio/library/`，账号和个人范围继续隔离。每条录音保留独立目录及稳定 ID，行数据返回 `storagePath`。转写完成和校对保存后自动写入当前完整 JSON、Markdown、TXT 和按 revision 命名的副本。自动可读文件由服务端完整稿生成，不读取页面筛选结果。
