"""Managed offline worker: JSONL protocol on stdout, separate model processes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

from .benchmark import write_json
from .contracts import validate
from .paragraphs import merge_recording
from .preflight import sha256
from .resume import prepared_matches, stage_matches

PIPELINE_VERSION = "local-paragraph-v2-fixed120-bounded-speakers"
STAGES = ["preparing", "transcribing", "aligning", "diarizing", "merging"]


def bound_diarization(diarized: dict, duration_ms: int) -> tuple[dict, list[tuple[int, int]]]:
    """Normalize at most 40 ms of endpoint overshoot; retain raw model artifacts."""
    result, adjusted = dict(diarized), []
    for key in ["turns", "exclusiveTurns"]:
        result[key] = []
        for turn in diarized[key]:
            start, end = turn["startMs"], turn["endMs"]
            if type(start) is not int or type(end) is not int or start >= end or start < -40 or end > duration_ms + 40:
                raise ValueError("REVIEW_SPEAKER_TIME_OUTSIDE_SOURCE")
            bounded_start, bounded_end = max(0, min(duration_ms, start)), max(0, min(duration_ms, end))
            if (bounded_start, bounded_end) != (start, end):
                adjusted.append((bounded_start, bounded_end))
            if bounded_start < bounded_end:
                result[key].append({**turn, "startMs": bounded_start, "endMs": bounded_end})
    return result, adjusted


def canonical_transcript(recording: dict, prepared: dict, asr: dict, aligned: dict, diarized: dict, fingerprint: str) -> dict:
    diarized, adjusted = bound_diarization(diarized, prepared["durationMs"])
    candidate = merge_recording(prepared, asr, aligned, diarized, sample_id=recording["id"], title=recording["title"],
                                language="zh" if asr["language"] == "Chinese" else "en", artifact_hashes={})
    def model(value, engine):
        return {"engine": engine, "model": value["repo"], "revision": value["revision"], "quantization": "8bit" if engine == "mlx-audio" else None}
    segments = []
    for p in candidate["paragraphs"]:
        flags = []
        if p["speakerId"] is None or any(min(p["endMs"], end) > max(p["startMs"], start) for start, end in adjusted):
            flags.append("speaker_uncertain")
        if p["invalidWordCount"] or p["timing"] == "source_chunk_only" or any(x in p["issues"] for x in ["long_internal_gap", "unusually_long_word_span", "nonmonotonic_word_times", "word_time_outside_source"]):
            flags.append("unaligned")
        overlap = "overlapping_speech" in p["issues"] or "multiple_speakers_in_paragraph" in p["issues"]
        if overlap:
            flags.append("overlap")
        segments.append({"id": p["id"], "startMs": p["startMs"], "endMs": p["endMs"], "speakerId": p["speakerId"], "text": p["text"],
                         "timingSource": "asr_segment" if p["timing"] == "source_chunk_only" else "forced_alignment", "overlap": overlap,
                         "flags": flags, "sourceChunkIds": [p["source"]["chunkId"]], "words": [], "scores": None})
    # Do not reorder text to conceal a broken model timeline.
    if any(a["startMs"] > b["startMs"] for a, b in zip(segments, segments[1:])):
        raise ValueError("NONMONOTONIC_SEGMENT_TIMELINE")
    result = {"schemaVersion": 1, "recordingId": recording["id"], "sourceSha256": recording["sourceSha256"],
              "durationMs": prepared["durationMs"], "revisionId": "rev_machine_" + fingerprint[:32], "language": candidate["language"],
              "provenance": {"pipelineVersion": PIPELINE_VERSION, "asr": model(asr["model"], "mlx-audio"), "aligner": model(aligned["model"], "mlx-audio"), "diarizer": model(diarized["model"], "pyannote.audio")},
              "speakers": [{"id": s["id"], "displayName": s["name"], "nameSource": "default"} for s in candidate["speakers"]],
              "segments": segments,
              "speakerTurns": [{"id": f"turn_{i:06}", "startMs": t["startMs"], "endMs": t["endMs"], "speakerId": t["speakerId"], "overlap": any(o["speakerId"] != t["speakerId"] and min(o["endMs"], t["endMs"]) > max(o["startMs"], t["startMs"]) for o in diarized["turns"])} for i, t in enumerate(diarized["turns"])],
              "chunks": [{"id": c["id"], "startMs": c["startMs"], "endMs": c["endMs"], "paddingLeftMs": 0, "paddingRightMs": 0, "status": "ready", "errorCode": None} for c in prepared["chunks"]]}
    validate("Transcript", result)
    return result


class Runtime:
    def __init__(self, args, command):
        self.args, self.command = args, command
        self.sequence = 0
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.started = time.monotonic()

    def event(self, name, payload, stage=None):
        with self.lock:
            self.sequence += 1
            value = {"protocolVersion": 1, "event": name, "sequence": self.sequence, "jobId": None if name == "ready" else self.command["jobId"], "stage": stage, "payload": payload}
            validate("WorkerEvent", value)
            print(json.dumps(value, ensure_ascii=False), flush=True)

    def heartbeat(self):
        while not self.finished.wait(10):
            self.event("heartbeat", {"elapsedMs": round((time.monotonic() - self.started) * 1000)})

    def parent_guard(self):
        while not self.finished.wait(.5):
            if self.args.parent_pid and os.getppid() != self.args.parent_pid:
                # Node owns this dedicated process group. A crashed parent must not
                # leave a model/FFmpeg process using the GPU after service restart.
                if os.name == "posix" and os.getpgrp() == os.getpid():
                    os.killpg(os.getpid(), signal.SIGTERM)
                os._exit(1)

    def listen(self):
        for line in sys.stdin:
            try:
                value = json.loads(line)
                validate("WorkerCommand", value)
                if value["command"] == "cancel" and value["jobId"] == self.command["jobId"]:
                    self.cancelled.set()
            except (ValueError, TypeError):
                pass

    def run_process(self, module, arguments, stage):
        process = subprocess.Popen([sys.executable, "-m", module, *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        def output():
            for line in process.stdout:
                progress = re.match(r"(?:asr|align): (\d+)/(\d+)", line)
                if progress:
                    self.event("progress", {"completedUnits": int(progress[1]), "totalUnits": int(progress[2]), "unit": "chunks"}, stage)
        thread = threading.Thread(target=output, daemon=True)
        thread.start()
        while process.poll() is None:
            if self.cancelled.wait(.2):
                process.terminate()
                try:
                    process.wait(3)
                except subprocess.TimeoutExpired:
                    process.kill()
                thread.join(1)
                raise InterruptedError()
        thread.join(2)
        process.stdout.close()
        if process.returncode != 0:
            raise RuntimeError("MODEL_STAGE_FAILED")

    def run(self):
        args, payload = self.args, self.command["payload"]
        recording = json.loads((args.recording_dir / "recording.json").read_text())
        if recording["id"] != payload["recordingId"]:
            raise ValueError("SOURCE_ID_MISMATCH")
        asset = next(a for a in recording["assets"] if a["id"] == payload["sourceAssetId"])
        source = (args.recording_dir / asset["relativePath"]).resolve()
        if not source.is_relative_to(args.recording_dir.resolve()) or sha256(source) != asset["sha256"]:
            raise ValueError("SOURCE_HASH_MISMATCH")
        work = args.recording_dir / "work" / payload["pipelineFingerprint"]
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        language = "English" if payload["language"] == "en" else "Chinese"
        self.event("stage_started", {"inputFingerprint": payload["pipelineFingerprint"]}, "preparing")
        self.run_process("recdock_audio.models", ["--root", str(args.models), "--verify"], "preparing")
        try:
            prepared_ok = prepared_matches(work, source)
        except (OSError, ValueError, KeyError):
            prepared_ok = False
        if not prepared_ok:
            self.run_process("recdock_audio.benchmark", ["prepare", "--source", str(source), "--output-dir", str(work), "--chunk-seconds", "120"], "preparing")
        self.event("artifact", {"kind": "preparing", "relativePath": "prepare.json", "sha256": sha256(work / "prepare.json")}, "preparing")
        for stage, name in [("transcribing", "asr"), ("aligning", "align"), ("diarizing", "diarize")]:
            if self.cancelled.is_set():
                raise InterruptedError()
            self.event("stage_started", {"inputFingerprint": payload["pipelineFingerprint"]}, stage)
            try:
                cached = stage_matches(work, args.models, name, language, args.device)
            except (OSError, ValueError, KeyError):
                cached = False
            if not cached:
                module = "recdock_audio.benchmark"
                arguments = [name, "--output-dir", str(work), "--models", str(args.models), "--language", language, "--device", args.device]
                if name == "asr" and (work / "asr.json").exists():
                    module = "recdock_audio.retry_asr"
                    arguments = ["--output-dir", str(work), "--models", str(args.models), "--language", language]
                self.run_process(module, arguments, stage)
                if not stage_matches(work, args.models, name, language, args.device):
                    raise RuntimeError("STAGE_RESULT_INVALID")
            self.event("artifact", {"kind": stage, "relativePath": name + ".json", "sha256": sha256(work / (name + ".json"))}, stage)
        self.event("stage_started", {"inputFingerprint": payload["pipelineFingerprint"]}, "merging")
        data = {name: json.loads((work / (name + ".json")).read_text()) for name in ["prepare", "asr", "align", "diarize"]}
        transcript = canonical_transcript(recording, data["prepare"], data["asr"], data["align"], data["diarize"], payload["pipelineFingerprint"])
        write_json(work / "transcript.json", transcript)
        self.event("artifact", {"kind": "merging", "relativePath": "transcript.json", "sha256": sha256(work / "transcript.json")}, "merging")
        self.event("completed", {"transcriptRelativePath": "transcript.json", "sha256": sha256(work / "transcript.json")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recording-dir", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "mps"], default="mps")
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    for key, value in {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "PYANNOTE_METRICS_ENABLED": "0", "HF_HUB_DISABLE_XET": "1"}.items():
        os.environ[key] = value
    command = json.loads(sys.stdin.readline(65536))
    validate("WorkerCommand", command)
    if command["command"] != "run":
        raise SystemExit(2)
    runtime = Runtime(args, command)
    runtime.event("ready", {"workerVersion": PIPELINE_VERSION, "capabilities": STAGES})
    threading.Thread(target=runtime.heartbeat, daemon=True).start()
    threading.Thread(target=runtime.listen, daemon=True).start()
    threading.Thread(target=runtime.parent_guard, daemon=True).start()
    try:
        runtime.run()
    except InterruptedError:
        runtime.event("cancelled", {"reason": "user"})
    except Exception as error:
        code = str(error) if re.fullmatch(r"[A-Z_]{1,64}", str(error)) else "AUDIO_PROCESSING_FAILED"
        runtime.event("failed", {"code": code, "message": "本机处理未完成，已保留原音频和已完成阶段，可重试。", "retryable": True})
    finally:
        runtime.finished.set()


if __name__ == "__main__":
    main()
