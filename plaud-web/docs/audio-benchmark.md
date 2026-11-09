# 第一阶段本机音频基准运行说明

三个模型已下载并核验，四个样本的 ASR、时间对齐和 MPS 说话人区分均已真实运行，短样本还完成了 CPU 对照。长音频词级对齐存在较多无效时间，G0 尚未通过。首次隔离进程无法访问 Metal GPU，当时 GPU 任务由用户普通 macOS 终端启动。工作台页面尚未接入这些实验工具。

两条长录音现已生成段落、句段时间与讲话人合并的核对稿，支持回听、编辑和全文导出。查看入口及 30 秒切块对照见[长音频核对报告](reports/audio-review-2026-11-03.md)。本轮权限环境调整后已能直接访问 Metal，短切块对照已由 Agent 执行，不再需要用户手动启动这些实验。

## 当前机器直接运行

工程内的 `worker/.venv` 已准备，依赖完整性检查通过。进入工程后运行：

```sh
cd /path/to/recdock/plaud-web
bash scripts/audio-spike.sh run --suite all --diarizer-device mps
```

默认素材目录为当前用户的 `~/Downloads/audiobridge素材/音频测试`；可用 `--source-dir` 指定其他目录。`--suite short` 只处理两个短样本，`--suite all` 包含约 103 分钟中文周会与 81 分钟英文访谈。仅读取原始录音，计算副本和结果写入 `.local-audio/`。

`--diarizer-device mps` 在当前 M3 Pro 的两个短样本和两个长样本上已完成运行验证。兼容路径使用 `--diarizer-device cpu`，不传参数时也默认 CPU。每种设备的结果另存为 `diarize.cpu.json` / `diarize.mps.json`，可比较实际差异。

需要恢复已中断的基准时使用：

```sh
bash scripts/audio-spike.sh run --suite all --diarizer-device mps --resume
```

只复用源哈希、解码帧、模型版本、语言和设备等仍匹配的结果。ASR 可复用已经通过结构检查的块，只重试缺失或异常块；文字改变后不能复用旧对齐。当前中文长样本已经验证“复用 51 块、重算 1 块”的恢复路径。累计计算时间与本次恢复时间分别记录。

脚本先检查 GPU 与依赖。模型文件完整时复用本地固定版本，不重复下载。首次缺少凭据时，引导在终端或其打开的页面登录 Hugging Face。pyannote 模型页还需填写单位/个人情况、选择用途并提交访问申请，登录成功不等于已获得该仓库访问权。脚本不会代为确认条款。凭据只供本机下载使用，不需要 OpenAI API Key，不应发到聊天中。

可分步执行：

```sh
bash scripts/audio-spike.sh check
bash scripts/audio-spike.sh auth
bash scripts/audio-spike.sh prepare-models
bash scripts/audio-spike.sh run --suite short
```

如果 GPU 检查返回 `MLX_DEVICE_UNAVAILABLE`，脚本在下载和推理前停止。应在可访问图形设备的普通本机终端执行，不把隔离环境失败当成 Mac 硬件不支持。

## 环境重建

一期基准锁定 Python 3.11、macOS ARM64。Python 3.12 的自动准备在本轮执行环境中失败，暂用本机已有 3.11.14；候选库的声明支持此版本。Python 3.12 未做共同环境验证，不沿用为已验证配置。

```sh
bash scripts/audio-spike.sh setup
```

依赖清单位于 `worker/pyproject.toml`，完整解析结果与安装包哈希位于 `worker/requirements-macos-arm64.lock`。此锁已在全新虚拟环境中离线重建 111 个包并通过检查；它仍是可行性阶段环境，不代表模型质量或处理速度已经验收。

HF 缓存、Matplotlib 缓存、模型、基准录音副本、登录凭据均位于被 Git 忽略的 `.local-audio/` 下。手动启动 Python 模块时，也应设置项目缓存路径；推荐统一使用脚本入口。

## 处理方式与产物

模型在准备时解析并固定精确仓库 commit，写入 `.local-audio/models/models.lock.json`，记录各文件哈希。之后优先复用这个 commit，缺文件时补齐同版本，不静默更新模型。运行前校验模型文件，推理阶段设置离线模式。

首次 Xet 下载通道在当前网络下重试失败，现默认使用普通 HTTP：`HF_HUB_DISABLE_XET=1`，下载/元数据超时分别为 60/30 秒，单文件下载并发为 1。网络失败最多重试三次，权限拒绝直接停止；未完成下载也先保存固定 revision。依据仓库元数据检查小文件的 Git blob 哈希和大文件的 LFS SHA-256，不能把仅有配置文件的目录标成模型就绪。[Hugging Face 环境变量说明](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables)

具体模型版本与许可见[模型来源记录](../worker/MODEL-NOTICES.md)。

这是固定 120 秒、无重叠的可行性基线，尚未实现生产 VAD、接缝处理和最终全文合并。触及生成上限或出现明显重复循环时，ASR 对该块按 30/10/5 秒自适应重试；仍无法解决则保留原件与失败记录，不静默删除。每块及恢复子块使用采样帧记录原始时间；对齐请求小于 300 秒。人物区分对整条解码音频运行，保留普通 turns 和 exclusive turns；不按各 ASR 块独立编号。

| 路径 | 内容 |
| --- | --- |
| `.local-audio/reports/environment.json` | 当前隔离环境检查结果 |
| `.local-audio/reports/environment-host.json` | 通过脚本在本机终端生成的环境结果 |
| `.local-audio/reports/samples.json` | 四个原始文件的哈希、格式和全程解码结果 |
| `.local-audio/runs/last-run.json` | 最近一次整套运行的阶段、设备和真实退出状态 |
| `.local-audio/models/prepare-state.json` | 当前模型准备阶段与实际重试次数 |
| `.local-audio/models/prepare.failure.json` | 模型下载失败原因分类，不含 token 或签名 URL |
| `.local-audio/benchmarks/<sample-id>/prepare.json` | 源哈希、解码时长和分块原始时间映射 |
| 同目录 `asr.json`、`asr.txt` | 转写原始结果、分块时间、是否触及生成上限 |
| 同目录 `align.json` | 词/字时间及全局范围检查标记 |
| 同目录 `diarize.json` | 整条人物 turns、exclusive turns 与运行设备 |
| 同目录 `history/`、`recovery/` | 恢复前的原始结果、重试音频与逐子块真实输出 |
| 同目录 `<stage>.failure.json` | 阶段失败的实际错误，不能当成成功结果 |
| `.local-audio/reports/benchmark-audit.json` | 分块覆盖、源时间、无效词时间与 CPU/MPS 一致性检查 |

各模型阶段独立启动进程，记录包含加载的 RTF、加载时间、进程峰值 RSS；MLX 分配内存单列，不与 RSS 简单相加。模型加载成功、完成全部块和质量验收是不同结论。

当前 TorchCodec 内建解码器未能加载其所需的 FFmpeg 动态库。基准使用外部 FFmpeg 解码，再将 waveform 传给 pyannote；两个短样本的 CPU 和 MPS 模型推理均已通过。此适配路径不使用内建解码器，过滤该未使用组件的导入警告，其余运行警告保留，不替换系统 FFmpeg。

可随时对已落盘的结果执行独立检查：

```sh
PYTHONPATH=worker worker/.venv/bin/python -m recdock_audio.audit \
  --root .local-audio/benchmarks --output .local-audio/reports/benchmark-audit.json
```

检查器不把尚未完成的块当成全程成功，不把零时长词当作有效时间，也不把 CPU/MPS 的一致性当成真实人物准确率。

## 质量评分与人工参考

当前素材目录没有这四个样本的顶层参考文本或人物标注。不得把模型自己的转写作为参考，也不得把“运行结束”报告成 CER/WER 达标。

两个短样本先逐字核对全文，另行标注真实人物与换人位置。长样本首中尾和困难区域建立独立的 10–15 分钟参考；抽样误差率不能标为整条准确率。重叠、未知归属、未对齐比例以及人物在首中尾是否稳定需单独检查。

完整短样本的 CER/WER 工具已提供。将 `worker/benchmarks/reference-template.json` 复制到 `.local-audio/references/`，按 `prepare.json` 填写源哈希和解码时长，写入人工参考文字，并仅在核对后将 `humanReviewed` 设为 true。

也可以打开 `.local-audio/reports/short-review.html`，回听、修正候选全文并保存人工参考。此页面包含两个短样本的本地音频、候选文字、人物区间与词时间；不联网，不自动勾选人工确认。生成命令为：

```sh
PYTHONPATH=worker worker/.venv/bin/python -m recdock_audio.review \
  --root .local-audio/benchmarks --output .local-audio/reports/short-review.html
```

人工参考准备好后执行评分：

```sh
PYTHONPATH=worker worker/.venv/bin/python -m recdock_audio.scoring \
  --reference .local-audio/references/zh-short.json \
  --asr .local-audio/benchmarks/zh-short/asr.json \
  --output .local-audio/benchmarks/zh-short/quality.json
```

工具拒绝未审核、空参考、来源不符以及不完整 ASR。当前归一化为 NFKC、忽略大小写、按语言处理标点；数字不自动转为另一种表达。它只支持完整录音参考；长录音抽样评分、时间偏差统计和 DER 仍需在 T02 后续验证中完成。

## 工程检查

```sh
npm test
npm run build
cd worker
.venv/bin/python -m unittest discover -s tests -v
```

模型真实基准不在日常单元测试中自动执行。共享合成契约用例、时间映射测试和评分算法测试不证明实际音频的识别质量。
