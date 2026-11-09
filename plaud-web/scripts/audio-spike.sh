#!/usr/bin/env bash
# Run in the user's ordinary macOS terminal, using only this project's environment.
set -euo pipefail
umask 077

RECDOCK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECDOCK_PYTHON="$RECDOCK_ROOT/worker/.venv/bin/python"
export UV_CACHE_DIR="$RECDOCK_ROOT/.local-audio/cache/uv"
export HF_HOME="$RECDOCK_ROOT/.local-audio/huggingface"
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
export HF_HUB_DOWNLOAD_TIMEOUT="${HF_HUB_DOWNLOAD_TIMEOUT:-60}"
export HF_HUB_ETAG_TIMEOUT="${HF_HUB_ETAG_TIMEOUT:-30}"
export PYANNOTE_METRICS_ENABLED=0
export MPLCONFIGDIR="$RECDOCK_ROOT/.local-audio/cache/matplotlib"
export XDG_CACHE_HOME="$RECDOCK_ROOT/.local-audio/cache"
export PYTHONPATH="$RECDOCK_ROOT/worker"
RECDOCK_MODE="${1:-help}"
if (( $# )); then shift; fi
RECDOCK_SOURCE_DIR="$HOME/Downloads/audiobridge素材/音频测试"
RECDOCK_SUITE=short
RECDOCK_DIARIZER_DEVICE=cpu
RECDOCK_RESUME=0
RECDOCK_STEP=starting
RECDOCK_RUN_ID=""
record_run() {
  "$RECDOCK_PYTHON" - "$RECDOCK_RUN_ID" "$RECDOCK_SUITE" "$RECDOCK_STEP" "$1" "$2" "$RECDOCK_DIARIZER_DEVICE" <<'PY'
import json, os, sys, time
from pathlib import Path
run_id, suite, phase, status, exit_code, device = sys.argv[1:]
value = {"schemaVersion": 1, "runId": run_id, "suite": suite, "phase": phase,
         "status": status, "exitCode": int(exit_code), "diarizerDevice": device, "updatedAtMs": int(time.time() * 1000)}
for path in [Path('.local-audio/runs') / run_id / 'run.json', Path('.local-audio/runs/last-run.json')]:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)
PY
}
while (( $# )); do
  case "$1" in
    -h|--help) RECDOCK_MODE=help; shift ;;
    --source-dir) RECDOCK_SOURCE_DIR="$2"; shift 2 ;;
    --suite) RECDOCK_SUITE="$2"; shift 2 ;;
    --diarizer-device) RECDOCK_DIARIZER_DEVICE="$2"; shift 2 ;;
    --resume) RECDOCK_RESUME=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
cd "$RECDOCK_ROOT"

case "$RECDOCK_MODE" in
  setup)
    if [[ ! -x "$RECDOCK_PYTHON" ]]; then
      uv venv --python 3.11 "$RECDOCK_ROOT/worker/.venv"
    fi
    uv pip install --python "$RECDOCK_PYTHON" --require-hashes -r worker/requirements-macos-arm64.lock
    ;;
  auth)
    "$RECDOCK_ROOT/worker/.venv/bin/hf" auth login --force
    ;;
  check)
    "$RECDOCK_PYTHON" -m recdock_audio.preflight environment --accelerators --output .local-audio/reports/environment-host.json
    "$RECDOCK_PYTHON" -c 'import json; p=json.load(open(".local-audio/reports/environment-host.json")); raise SystemExit(2 if p["blockers"] else 0)'
    ;;
  prepare-models)
    "$RECDOCK_PYTHON" -m recdock_audio.models --root .local-audio/models
    ;;
  run)
    RECDOCK_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    trap 'RECDOCK_RESULT=$?; if (( RECDOCK_RESULT == 0 )); then record_run completed 0; else record_run failed "$RECDOCK_RESULT"; fi' EXIT
    record_run running 0
    [[ "$RECDOCK_SUITE" == short || "$RECDOCK_SUITE" == all ]] || { echo 'suite 仅支持 short 或 all' >&2; exit 2; }
    [[ "$RECDOCK_DIARIZER_DEVICE" == cpu || "$RECDOCK_DIARIZER_DEVICE" == mps ]] || { echo 'diarizer-device 仅支持 cpu 或 mps' >&2; exit 2; }
    [[ -d "$RECDOCK_SOURCE_DIR" ]] || { echo '找不到音频目录，请使用 --source-dir 指定' >&2; exit 2; }
    RECDOCK_STEP=gpu_check; record_run running 0
    bash "$RECDOCK_ROOT/scripts/audio-spike.sh" check
    if ! "$RECDOCK_PYTHON" -c 'import json; from pathlib import Path; from huggingface_hub import get_token; p=Path(".local-audio/models/models.lock.json"); cached=p.exists() and "diarizer" in json.loads(p.read_text()).get("models", {}); raise SystemExit(0 if get_token() or cached else 1)'; then
      echo '首次准备说话人模型需要在本机登录 Hugging Face。请仅在终端或其打开的登录页面操作。'
      RECDOCK_STEP=authentication; record_run running 0
      bash "$RECDOCK_ROOT/scripts/audio-spike.sh" auth
    fi
    RECDOCK_STEP=model_preparation; record_run running 0
    bash "$RECDOCK_ROOT/scripts/audio-spike.sh" prepare-models
    RECDOCK_STEP=model_verification; record_run running 0
    "$RECDOCK_PYTHON" -m recdock_audio.models --root .local-audio/models --verify
    for RECDOCK_ID in zh-short en-short zh-long en-long; do
      if [[ "$RECDOCK_SUITE" == short && "$RECDOCK_ID" == *-long ]]; then continue; fi
      case "$RECDOCK_ID" in
        zh-short) RECDOCK_FILE='0-four-speakers-zh.wav'; RECDOCK_LANGUAGE=Chinese ;;
        en-short) RECDOCK_FILE='3-two-speakers-en.wav'; RECDOCK_LANGUAGE=English ;;
        zh-long) RECDOCK_FILE='02-24周会录音-飞飞.mp3'; RECDOCK_LANGUAGE=Chinese ;;
        en-long) RECDOCK_FILE='Steve Jobs & Bill Gates_ A Conversation That Shaped Technology.mp3'; RECDOCK_LANGUAGE=English ;;
      esac
      RECDOCK_OUTPUT=".local-audio/benchmarks/$RECDOCK_ID"
      RECDOCK_STEP="$RECDOCK_ID:prepare"; record_run running 0
      if (( RECDOCK_RESUME )) && "$RECDOCK_PYTHON" -m recdock_audio.resume prepared --output-dir "$RECDOCK_OUTPUT" --source "$RECDOCK_SOURCE_DIR/$RECDOCK_FILE"; then
        echo "$RECDOCK_ID: 复用已核验的解码和分块"
      else
        "$RECDOCK_PYTHON" -m recdock_audio.benchmark prepare --source "$RECDOCK_SOURCE_DIR/$RECDOCK_FILE" --output-dir "$RECDOCK_OUTPUT"
      fi
      for RECDOCK_STAGE in asr align diarize; do
        RECDOCK_STEP="$RECDOCK_ID:$RECDOCK_STAGE"; record_run running 0
        if (( RECDOCK_RESUME )) && "$RECDOCK_PYTHON" -m recdock_audio.resume stage --output-dir "$RECDOCK_OUTPUT" --models .local-audio/models --stage "$RECDOCK_STAGE" --language "$RECDOCK_LANGUAGE" --device "$RECDOCK_DIARIZER_DEVICE"; then
          echo "$RECDOCK_ID: 复用已完成的 $RECDOCK_STAGE"
        elif (( RECDOCK_RESUME )) && [[ "$RECDOCK_STAGE" == asr && -f "$RECDOCK_OUTPUT/asr.json" ]]; then
          "$RECDOCK_PYTHON" -m recdock_audio.retry_asr --output-dir "$RECDOCK_OUTPUT" --models .local-audio/models --language "$RECDOCK_LANGUAGE"
        else
          "$RECDOCK_PYTHON" -m recdock_audio.benchmark "$RECDOCK_STAGE" --output-dir "$RECDOCK_OUTPUT" --models .local-audio/models --language "$RECDOCK_LANGUAGE" --device "$RECDOCK_DIARIZER_DEVICE"
        fi
      done
    done
    RECDOCK_STEP=finished
    echo '推理基准结束。结果位于 .local-audio/benchmarks，质量评分仍需人工参考标注。'
    ;;
  *)
    echo '用法：bash scripts/audio-spike.sh setup|auth|check|prepare-models|run [--suite short|all] [--source-dir 目录] [--diarizer-device cpu|mps] [--resume]'
    ;;
esac
