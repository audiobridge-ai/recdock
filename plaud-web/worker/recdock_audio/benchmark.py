"""Feasibility benchmark, not the production queue or final transcript merger."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import resource
import subprocess
import time
import wave
import warnings

from .preflight import audio_tool, sha256


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def prepare(source: Path, output: Path, chunk_seconds: int) -> dict:
    if not 1 <= chunk_seconds < 300:
        raise ValueError("alignment chunks must be shorter than 300 seconds")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    decoded = output / "decoded.wav"
    subprocess.run([audio_tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(decoded)], check=True, timeout=1800)
    chunks = []
    with wave.open(str(decoded), "rb") as audio:
        total = audio.getnframes()
        sample_rate = audio.getframerate()
        width = chunk_seconds * sample_rate
        for index, start in enumerate(range(0, total, width)):
            count = min(width, total - start)
            path = output / f"chunk-{index:04d}.wav"
            with wave.open(str(path), "wb") as chunk:
                chunk.setparams(audio.getparams())
                chunk.writeframes(audio.readframes(count))
            chunks.append({"id": f"chunk_{index:04d}", "path": path.name, "startFrame": start,
                           "frameCount": count, "startMs": round(start * 1000 / sample_rate),
                           "endMs": round((start + count) * 1000 / sample_rate)})
    manifest = {"schemaVersion": 1, "sourceSha256": sha256(source), "sampleRate": sample_rate,
                "decodedFrames": total, "durationMs": round(total * 1000 / sample_rate),
                "chunking": "fixed_nonoverlapping_baseline_not_production_vad", "chunks": chunks}
    write_json(output / "prepare.json", manifest)
    return manifest


def load_lock(root: Path, name: str) -> dict:
    lock = json.loads((root / "models.lock.json").read_text())
    model = lock["models"][name]
    if not (root / name).is_dir():
        raise RuntimeError("MODEL_MISSING:" + name)
    return model


def run_stage(stage: str, output: Path, models: Path, language: str, device: str) -> dict:
    manifest = json.loads((output / "prepare.json").read_text())
    duration = manifest["durationMs"] / 1000
    started = time.monotonic()
    result = {"schemaVersion": 1, "stage": stage, "sourceSha256": manifest["sourceSha256"],
              "durationMs": manifest["durationMs"], "status": "running", "chunks": [],
              "preparedSha256": sha256(output / "prepare.json"),
              "runtime": {"python": platform.python_version(), "engine": "mlx-audio" if stage in ("asr", "align") else "pyannote.audio",
                          "engineVersion": importlib.metadata.version("mlx-audio" if stage in ("asr", "align") else "pyannote.audio")},
              "qualityMetrics": {"status": "not_scored", "reason": "human_reference_required"}}
    write_json(output / (stage + ".json"), result)
    if stage in ("asr", "align"):
        name = "asr" if stage == "asr" else "aligner"
        result["model"] = load_lock(models, name)
        result["model"] = {k: v for k, v in result["model"].items() if k != "files"}
        from mlx_audio.stt import load
        import mlx.core as mx
        model = load(str((models / name).resolve()))
        result["modelLoadSeconds"] = time.monotonic() - started
        result["language"] = language
        previous = json.loads((output / "asr.json").read_text()) if stage == "align" else None
        if previous is not None and (previous["sourceSha256"] != manifest["sourceSha256"] or previous["status"] != "completed"):
            raise RuntimeError("ASR_INPUT_NOT_COMPLETE")
        previous_chunks = {c["id"]: c for c in previous["chunks"]} if previous else {}
        for chunk in manifest["chunks"]:
            begin = time.monotonic()
            path = output / chunk["path"]
            if stage == "asr":
                generated = model.generate(str(path), language=language, max_tokens=2048, temperature=0.0, verbose=False)
                item = {**chunk, "text": generated.text, "tokenLimitReached": getattr(generated, "generation_tokens", 0) >= 2048}
                from .retry_asr import suspect_text, recover_chunk
                if item["tokenLimitReached"] or suspect_text(item["text"]):
                    print(json.dumps({"asrRecovery": chunk["id"], "reason": "generation_limit" if item["tokenLimitReached"] else "suspected_repetition"}), flush=True)
                    recovered = recover_chunk(chunk, output, model, language)
                    item = {**recovered, "initialGenerationLimited": item["tokenLimitReached"]}
            else:
                text = previous_chunks[chunk["id"]]["text"]
                aligned = model.generate(str(path), text=text, language=language) if text.strip() else None
                words = []
                for word in aligned.items if aligned else []:
                    if not (math.isfinite(word.start_time) and math.isfinite(word.end_time)):
                        raise RuntimeError("NONFINITE_ALIGNMENT")
                    start_ms = chunk["startMs"] + round(word.start_time * 1000)
                    end_ms = chunk["startMs"] + round(word.end_time * 1000)
                    valid = chunk["startMs"] <= start_ms < end_ms <= chunk["endMs"]
                    words.append({**asdict(word), "startMs": start_ms, "endMs": end_ms, "validSourceRange": valid})
                item = {**chunk, "text": text, "words": words}
            item["inferenceSeconds"] = time.monotonic() - begin
            result["chunks"].append(item)
            write_json(output / (stage + ".json"), result)
            print(f"{stage}: {len(result['chunks'])}/{len(manifest['chunks'])}", flush=True)
        result["mlxPeakAllocationBytes"] = mx.get_peak_memory()
        if stage == "asr":
            (output / "asr.txt").write_text("\n\n".join(f"[{c['startMs']/1000:.3f}–{c['endMs']/1000:.3f}] {c['text']}" for c in result["chunks"]), encoding="utf-8")
            result["tokenLimitReached"] = any(c["tokenLimitReached"] for c in result["chunks"])
            result["unresolvedRepetition"] = any(c.get("suspectedRepetition") for c in result["chunks"])
    else:
        # This adapter always supplies externally decoded PCM, so TorchCodec is unused.
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=r"\s*torchcodec is not installed correctly so built-in audio decoding will fail", category=UserWarning, module=r"pyannote\.audio\.core\.io")
            from pyannote.audio import Pipeline
            from pyannote.audio.pipelines.utils.hook import ProgressHook
        import torch
        import numpy as np
        result["model"] = {k: v for k, v in load_lock(models, "diarizer").items() if k != "files"}
        pipeline = Pipeline.from_pretrained(str((models / "diarizer").resolve()))
        pipeline.to(torch.device(device))
        result["modelLoadSeconds"] = time.monotonic() - started
        # Supply waveform directly, avoiding decoder variability during the model benchmark.
        with wave.open(str(output / "decoded.wav"), "rb") as audio:
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        with ProgressHook() as hook:
            predicted = pipeline({"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": manifest["sampleRate"]}, hook=hook)
        def turns(annotation):
            return [{"startMs": round(turn.start * 1000), "endMs": round(turn.end * 1000), "speakerId": speaker}
                    for turn, _, speaker in annotation.itertracks(yield_label=True)]
        result["turns"] = turns(predicted.speaker_diarization)
        result["exclusiveTurns"] = turns(predicted.exclusive_speaker_diarization)
        result["device"] = device
        result["decoder"] = "ffmpeg_pcm_waveform"
    result["elapsedSeconds"] = time.monotonic() - started
    result["rtfIncludingLoad"] = result["elapsedSeconds"] / duration
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result["peakProcessRssBytes"] = peak if platform.system() == "Darwin" else peak * 1024
    result["status"] = "incomplete" if result.get("tokenLimitReached") or result.get("unresolvedRepetition") else "completed"
    write_json(output / (stage + ".json"), result)
    if stage == "diarize":
        write_json(output / ("diarize." + device + ".json"), result)
    (output / (stage + ".failure.json")).unlink(missing_ok=True)
    return result


def main() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "asr", "align", "diarize"))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--language", choices=("Chinese", "English"), default="Chinese")
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--chunk-seconds", type=int, default=120)
    args = parser.parse_args()
    if args.stage == "prepare":
        if args.source is None:
            parser.error("prepare requires --source")
        result = prepare(args.source, args.output_dir, args.chunk_seconds)
    else:
        if args.models is None:
            parser.error("model stages require --models")
        try:
            result = run_stage(args.stage, args.output_dir, args.models, args.language, args.device)
        except Exception as error:
            failure = {"stage": args.stage, "errorType": type(error).__name__, "message": str(error)[:2000]}
            write_json(args.output_dir / (args.stage + ".failure.json"), failure)
            if args.stage == "diarize":
                write_json(args.output_dir / ("diarize." + args.device + ".failure.json"), failure)
            result_path = args.output_dir / (args.stage + ".json")
            failed = json.loads(result_path.read_text()) if result_path.exists() else {"stage": args.stage}
            failed.update(status="failed", errorType=type(error).__name__)
            write_json(result_path, failed)
            raise
    print(json.dumps({k: v for k, v in result.items() if k not in ("chunks", "turns", "exclusiveTurns")}))
    if result.get("status") == "incomplete":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
