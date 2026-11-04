"""Compare 30 s ASR+alignment with existing 120 s candidate windows, never as truth."""

import argparse
from dataclasses import asdict
import gc
import json
import os
from pathlib import Path
import time
import wave

from .benchmark import load_lock, write_json
from .preflight import sha256
from .retry_asr import suspect_text
from .scoring import error_rate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for key, value in {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "PYANNOTE_METRICS_ENABLED": "0"}.items():
        os.environ[key] = value
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    jobs = []
    samples = {}
    for sample, language in [("zh-long", "Chinese"), ("en-long", "English")]:
        root = args.root / sample
        prepared = json.loads((root / "prepare.json").read_text())
        asr = json.loads((root / "asr.json").read_text())
        align = json.loads((root / "align.json").read_text())
        windows = [0, len(prepared["chunks"]) // 2, len(prepared["chunks"]) - 1]
        samples[sample] = {"sourceSha256": prepared["sourceSha256"], "asrArtifactSha256": sha256(root / "asr.json"),
                           "alignmentArtifactSha256": sha256(root / "align.json"), "windows": [], "language": language}
        with wave.open(str(root / "decoded.wav"), "rb") as source:
            for index in windows:
                parent = prepared["chunks"][index]
                record = {"chunkId": parent["id"], "startMs": parent["startMs"], "endMs": parent["endMs"],
                          "baselineText": asr["chunks"][index]["text"], "baselineWords": align["chunks"][index]["words"], "children": []}
                for start in range(parent["startFrame"], parent["startFrame"] + parent["frameCount"], 30 * prepared["sampleRate"]):
                    frames = min(30 * prepared["sampleRate"], parent["startFrame"] + parent["frameCount"] - start)
                    path = args.output / f"{sample}-{start}.wav"
                    source.setpos(start)
                    with wave.open(str(path), "wb") as target:
                        target.setparams(source.getparams())
                        target.writeframes(source.readframes(frames))
                    child = {"startMs": round(start * 1000 / prepared["sampleRate"]),
                             "endMs": round((start + frames) * 1000 / prepared["sampleRate"]), "path": path.name}
                    record["children"].append(child)
                    jobs.append((sample, language, child))
                samples[sample]["windows"].append(record)
    from mlx_audio.stt import load
    import mlx.core as mx
    started = time.monotonic()
    model = load(str((args.models / "asr").resolve()))
    for n, (sample, language, child) in enumerate(jobs):
        prediction = model.generate(str(args.output / child["path"]), language=language, max_tokens=2048, temperature=0.0, verbose=False)
        child.update(text=prediction.text, tokenLimitReached=getattr(prediction, "generation_tokens", 0) >= 2048,
                     suspectedRepetition=suspect_text(prediction.text))
        print(f"probe asr {n + 1}/{len(jobs)}", flush=True)
    asr_seconds = time.monotonic() - started
    del model
    gc.collect()
    mx.clear_cache()
    started = time.monotonic()
    model = load(str((args.models / "aligner").resolve()))
    for n, (sample, language, child) in enumerate(jobs):
        aligned = model.generate(str(args.output / child["path"]), text=child["text"], language=language)
        child["words"] = [{**asdict(w), "startMs": child["startMs"] + round(w.start_time * 1000),
                            "endMs": child["startMs"] + round(w.end_time * 1000)} for w in aligned.items]
        print(f"probe align {n + 1}/{len(jobs)}", flush=True)
    summary = {"status": "completed", "metricScope": "candidate_comparison_not_accuracy", "asrSeconds": asr_seconds,
               "alignSeconds": time.monotonic() - started, "samples": {},
               "models": {name: {k: v for k, v in load_lock(args.models, name).items() if k != "files"} for name in ["asr", "aligner"]}}
    for sample, data in samples.items():
        baseline_total = baseline_bad = short_total = short_bad = 0
        output = []
        for window in data["windows"]:
            baseline = window["baselineWords"]
            short = [w for child in window["children"] for w in child["words"]]
            baseline_total += len(baseline)
            baseline_bad += sum(not window["startMs"] <= w["startMs"] < w["endMs"] <= window["endMs"] for w in baseline)
            short_total += len(short)
            bad = sum(not child["startMs"] <= w["startMs"] < w["endMs"] <= child["endMs"] for child in window["children"] for w in child["words"])
            short_bad += bad
            difference = error_rate(window["baselineText"], " ".join(c["text"] for c in window["children"]), "zh" if sample.startswith("zh") else "en")
            difference["metric"] = "candidate_character_difference" if sample.startswith("zh") else "candidate_word_difference"
            difference["interpretation"] = "120s_candidate_is_not_a_human_reference"
            output.append({"chunkId": window["chunkId"], "startMs": window["startMs"], "endMs": window["endMs"],
                           "baselineWords": len(baseline), "shortWords": len(short), "shortInvalid": bad, "textDifference": difference})
        summary["samples"][sample] = {"sourceSha256": data["sourceSha256"], "windows": output,
                                       "baselineWords": baseline_total, "baselineInvalid": baseline_bad,
                                       "shortWords": short_total, "shortInvalid": short_bad,
                                       "generationProblems": sum(c["tokenLimitReached"] or c["suspectedRepetition"] for s, _, c in jobs if s == sample)}
    write_json(args.output / "results.json", {"schemaVersion": 1, "samples": samples})
    write_json(args.output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
