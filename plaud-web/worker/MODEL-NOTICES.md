# 可行性阶段模型来源与许可记录

以下为当前已下载并核验的候选模型，最终生产选型仍取决于 G0 质量验收。下载文件、仓库元数据和逐文件 SHA-256 保存在本机 `.local-audio/models/`，权重不进入源码仓库。

| 用途 | 发布方与模型 | 本机固定 revision | 模型卡许可 |
| --- | --- | --- | --- |
| 转写 | mlx-community，Qwen3-ASR-1.7B-8bit；源模型来自 Qwen | `a8379a2e2f9e313c9292cdf1af4055ab56d50d55` | Apache-2.0 |
| 时间对齐 | mlx-community，Qwen3-ForcedAligner-0.6B-8bit；源模型来自 Qwen | `0e1a68e91d815300c7c9754b2a7639378b23db15` | Apache-2.0 |
| 说话人区分 | pyannote，speaker-diarization-community-1 | `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee` | CC-BY-4.0 |

来源：[ASR 固定版本](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit/tree/a8379a2e2f9e313c9292cdf1af4055ab56d50d55)、[对齐模型固定版本](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit/tree/0e1a68e91d815300c7c9754b2a7639378b23db15)、[pyannote 固定版本](https://huggingface.co/pyannote/speaker-diarization-community-1/tree/3533c8cf8e369892e6b79ff1bf80f7b0286a54ee)。原仓库 README 与模型元数据随下载保留。

本轮未修改模型权重；两个 Qwen 模型的 MLX 转换与量化来自上述发布仓库。pyannote 下载条件已由用户在网页提交确认，随后仓库授权检查返回 200。模型卡中的原始引用和署名保留在本机下载副本中。
