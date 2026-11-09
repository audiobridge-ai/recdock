"""Recover only missing or suspect ASR chunks, preserving original sample offsets."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re
import resource
import shutil
import time
import unicodedata
import wave

from .benchmark import write_json, load_lock
from .preflight import sha256


def suspect_text(text: str) -> bool:
    normalized = "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))
    return len(normalized) >= 80 and re.search(r"(.{1,12}?)\1{11,}", normalized, re.DOTALL) is not None


def usable_chunk(chunk: dict, prepared: dict) -> bool:
    return all(chunk.get(k) == prepared[k] for k in ("id", "startMs", "endMs", "startFrame", "frameCount")) and not chunk.get("tokenLimitReached") and not chunk.get("suspectedRepetition") and not suspect_text(chunk.get("text", ""))


def recover_chunk(parent: dict, output: Path, model, language: str) -> dict:
    directory = output / "recovery" / parent["id"]
    directory.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output / parent["path"]), "rb") as source:
        params = source.getparams()
        sample_rate = source.getframerate()
        if source.getnframes() != parent["frameCount"]:
            raise ValueError("RECOVERY_SOURCE_FRAME_MISMATCH")
        leaves = []

        def predict(start: int, count: int, limit_seconds: int) -> None:
            width = limit_seconds * sample_rate
            for offset in range(start, start + count, width):
                frames = min(width, start + count - offset)
                path = directory / f"{offset}-{frames}.wav"
                source.setpos(offset)
                with wave.open(str(path), "wb") as target:
                    target.setparams(params)
                    target.writeframes(source.readframes(frames))
                began = time.monotonic()
                generated = model.generate(str(path), language=language, max_tokens=2048, temperature=0.0, verbose=False)
                limited = getattr(generated, "generation_tokens", 0) >= 2048
                repeating = suspect_text(generated.text)
                item = {"startFrame": parent["startFrame"] + offset, "frameCount": frames,
                        "startMs": round((parent["startFrame"] + offset) * 1000 / sample_rate),
                        "endMs": round((parent["startFrame"] + offset + frames) * 1000 / sample_rate),
                        "text": generated.text, "tokenLimitReached": limited, "suspectedRepetition": repeating,
                        "inferenceSeconds": time.monotonic() - began}
                write_json(path.with_suffix(".json"), item)
                if (limited or repeating) and limit_seconds > 5:
                    predict(offset, frames, 10 if limit_seconds > 10 else 5)
                else:
                    leaves.append(item)

        predict(0, parent["frameCount"], 30)
    if sum(x["frameCount"] for x in leaves) != parent["frameCount"]:
        raise ValueError("RECOVERY_FRAME_COVERAGE_INCOMPLETE")
    return {**parent, "text": " ".join(x["text"] for x in leaves), "recoverySubchunks": leaves,
            "tokenLimitReached": any(x["tokenLimitReached"] for x in leaves),
            "suspectedRepetition": any(x["suspectedRepetition"] for x in leaves),
            "inferenceSeconds": sum(x["inferenceSeconds"] for x in leaves)}


def recover(output: Path, models: Path, language: str) -> dict:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    prepared = json.loads((output / "prepare.json").read_text())
    previous = json.loads((output / "asr.json").read_text())
    selected = {k: v for k, v in load_lock(models, "asr").items() if k != "files"}
    if previous.get("sourceSha256") != prepared["sourceSha256"] or previous.get("preparedSha256") != sha256(output / "prepare.json") or previous.get("model") != selected or previous.get("language") != language or previous.get("runtime", {}).get("engineVersion") != importlib.metadata.version("mlx-audio"):
        raise ValueError("ASR_RECOVERY_INPUT_OR_MODEL_MISMATCH")
    expected = {c["id"]: c for c in prepared["chunks"]}
    prior = {c["id"]: c for c in previous["chunks"]}
    good = {key: value for key, value in prior.items() if key in expected and usable_chunk(value, expected[key])}
    if len(good) == len(expected):
        return previous
    history = output / "history"
    history.mkdir(exist_ok=True)
    archived = history / f"asr-{time.time_ns()}.json"
    shutil.copyfile(output / "asr.json", archived)
    archived.chmod(0o600)
    started = time.monotonic()
    from mlx_audio.stt import load
    import mlx.core as mx
    model = load(str((models / "asr").resolve()))
    load_seconds = time.monotonic() - started
    result = {**previous, "status": "running", "chunks": [], "tokenLimitReached": False,
              "reusedChunks": len(good), "recoveredChunks": 0, "modelLoadSeconds": load_seconds,
              "recoveryStrategy": "suspect_chunks_30s_then_10s_then_5s", "previousAttempt": str(archived.relative_to(output))}
    for parent in prepared["chunks"]:
        if parent["id"] in good:
            item = good[parent["id"]]
        else:
            item = recover_chunk(parent, output, model, language)
            result["recoveredChunks"] += 1
            print(json.dumps({"recoveredChunk": parent["id"], "subchunks": len(item["recoverySubchunks"]),
                              "resolved": not item["tokenLimitReached"] and not item["suspectedRepetition"]}), flush=True)
        result["chunks"].append(item)
        write_json(output / "asr.json", result)
    elapsed = time.monotonic() - started
    result["elapsedSeconds"] = elapsed
    result["cumulativeElapsedSeconds"] = (previous.get("cumulativeElapsedSeconds") or previous.get("elapsedSeconds") or 0) + elapsed
    result["rtfIncludingLoad"] = None  # This attempt recomputed only a subset of the recording.
    result["cumulativeRtfIncludingLoad"] = result["cumulativeElapsedSeconds"] / (prepared["durationMs"] / 1000)
    result["peakProcessRssBytes"] = max(previous.get("peakProcessRssBytes", 0), resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    result["mlxPeakAllocationBytes"] = max(previous.get("mlxPeakAllocationBytes", 0), mx.get_peak_memory())
    unresolved = any(c.get("tokenLimitReached") or c.get("suspectedRepetition") for c in result["chunks"])
    result["tokenLimitReached"] = any(c.get("tokenLimitReached") for c in result["chunks"])
    result["status"] = "incomplete" if unresolved else "completed"
    write_json(output / "asr.json", result)
    (output / "asr.txt").write_text("\n\n".join(f"[{c['startMs']/1000:.3f}–{c['endMs']/1000:.3f}] {c['text']}" for c in result["chunks"]), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--language", required=True, choices=("Chinese", "English"))
    args = parser.parse_args()
    try:
        result = recover(args.output_dir, args.models, args.language)
    except Exception as error:
        write_json(args.output_dir / "asr.recovery.failure.json", {"errorType": type(error).__name__, "message": str(error)[:2000]})
        raise
    print(json.dumps({k: result.get(k) for k in ("status", "reusedChunks", "recoveredChunks", "elapsedSeconds", "cumulativeElapsedSeconds")}))
    if result["status"] != "completed":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
