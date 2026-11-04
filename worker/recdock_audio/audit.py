"""Audit benchmark artifacts. Structural checks and backend agreement are not accuracy scores."""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

from .retry_asr import suspect_text


def backend_agreement(cpu: dict, accelerated: dict) -> dict:
    if cpu["sourceSha256"] != accelerated["sourceSha256"] or cpu["model"] != accelerated["model"]:
        raise ValueError("BACKEND_COMPARISON_SOURCE_OR_MODEL_MISMATCH")
    a, b = cpu["exclusiveTurns"], accelerated["exclusiveTurns"]
    a_labels = sorted({x["speakerId"] for x in a})
    b_labels = sorted({x["speakerId"] for x in b})
    if max(len(a_labels), len(b_labels)) > 8:
        raise ValueError("BACKEND_COMPARISON_SUPPORTS_UP_TO_EIGHT_SPEAKERS")
    points = sorted({t[k] for turn in (a, b) for t in turn for k in ("startMs", "endMs")})
    pairs = {}
    union_ms = both_ms = 0
    for start, end in zip(points, points[1:]):
        middle = (start + end) / 2
        first = next((x["speakerId"] for x in a if x["startMs"] <= middle < x["endMs"]), None)
        second = next((x["speakerId"] for x in b if x["startMs"] <= middle < x["endMs"]), None)
        if first is not None or second is not None:
            union_ms += end - start
        if first is not None and second is not None:
            both_ms += end - start
            pairs[first, second] = pairs.get((first, second), 0) + end - start
    size = max(len(a_labels), len(b_labels))
    left = a_labels + [None] * (size - len(a_labels))
    right = b_labels + [None] * (size - len(b_labels))
    best = 0
    for order in itertools.permutations(right):
        best = max(best, sum(pairs.get((x, y), 0) for x, y in zip(left, order)))
    return {"metric": "exclusive_backend_agreement_not_accuracy", "speechUnionMs": union_ms,
            "bothSpeechMs": both_ms, "matchedSpeakerMs": best, "agreement": best / union_ms if union_ms else None}


def audit_sample(root: Path) -> dict:
    prepared = json.loads((root / "prepare.json").read_text())
    expected = {x["id"]: x for x in prepared["chunks"]}
    result = {"sourceSha256": prepared["sourceSha256"], "durationMs": prepared["durationMs"],
              "preparedChunks": len(expected), "stages": {}, "qualityGate": "not_scored_without_human_reference"}
    for stage in ("asr", "align", "diarize"):
        path = root / (stage + ".json")
        if not path.exists():
            result["stages"][stage] = {"status": "not_started"}
            continue
        data = json.loads(path.read_text())
        entry = {k: data.get(k) for k in ("status", "elapsedSeconds", "cumulativeElapsedSeconds", "modelLoadSeconds", "rtfIncludingLoad", "cumulativeRtfIncludingLoad", "reusedChunks", "recoveredChunks", "peakProcessRssBytes", "mlxPeakAllocationBytes", "device")}
        issues = []
        if data.get("sourceSha256") != prepared["sourceSha256"]:
            issues.append("SOURCE_HASH_MISMATCH")
        if stage in ("asr", "align"):
            chunks = data.get("chunks", [])
            ids = [x["id"] for x in chunks]
            if len(set(ids)) != len(ids):
                issues.append("DUPLICATE_CHUNK")
            if data["status"] == "completed" and set(ids) != set(expected):
                issues.append("INCOMPLETE_CHUNK_COVERAGE")
            for chunk in chunks:
                source = expected.get(chunk["id"])
                if source is None or any(chunk.get(k) != source[k] for k in ("startMs", "endMs", "startFrame", "frameCount")):
                    issues.append("SOURCE_TIMELINE_MISMATCH")
            entry["completedChunks"] = len(chunks)
            if stage == "asr":
                entry["emptyTextChunks"] = sum(not c.get("text", "").strip() for c in chunks)
                if data.get("tokenLimitReached") or any(c.get("tokenLimitReached") for c in chunks):
                    issues.append("GENERATION_LIMIT_REACHED")
                if any(c.get("suspectedRepetition") or suspect_text(c.get("text", "")) for c in chunks):
                    issues.append("SUSPECTED_REPETITION_REQUIRES_REVIEW")
                for chunk in chunks:
                    if not chunk.get("recoverySubchunks"):
                        continue
                    cursor = chunk["startFrame"]
                    for child in chunk["recoverySubchunks"]:
                        if child["startFrame"] != cursor or child["frameCount"] <= 0 or child["startMs"] != round(cursor * 1000 / prepared["sampleRate"]) or child["endMs"] != round((cursor + child["frameCount"]) * 1000 / prepared["sampleRate"]):
                            issues.append("RECOVERY_TIMELINE_MISMATCH")
                        cursor += child["frameCount"]
                    if cursor != chunk["startFrame"] + chunk["frameCount"]:
                        issues.append("RECOVERY_FRAME_COVERAGE_INCOMPLETE")
            else:
                invalid = []
                words = 0
                for chunk in chunks:
                    for index, word in enumerate(chunk.get("words", [])):
                        words += 1
                        reason = None
                        if word["startMs"] == word["endMs"]:
                            reason = "ZERO_DURATION"
                        elif word["startMs"] > word["endMs"]:
                            reason = "REVERSED_RANGE"
                        elif not chunk["startMs"] <= word["startMs"] < word["endMs"] <= chunk["endMs"]:
                            reason = "OUTSIDE_SOURCE_CHUNK"
                        if reason:
                            invalid.append({"chunkId": chunk["id"], "wordIndex": index, "reason": reason,
                                            "startMs": word["startMs"], "endMs": word["endMs"]})
                entry.update(totalWords=words, invalidWordCount=len(invalid), invalidWords=invalid)
                if invalid:
                    issues.append("INVALID_WORD_TIMES_REQUIRE_UNALIGNED_MARKER")
        else:
            turns = data.get("turns", [])
            entry["speakerCount"] = len({x["speakerId"] for x in turns})
            entry["turnCount"] = len(turns)
            if any(not 0 <= x["startMs"] < x["endMs"] <= prepared["durationMs"] for x in turns):
                issues.append("SPEAKER_TURN_OUTSIDE_SOURCE")
        entry["issues"] = sorted(set(issues))
        result["stages"][stage] = entry
    cpu, mps = root / "diarize.cpu.json", root / "diarize.mps.json"
    if cpu.exists() and mps.exists():
        first, second = json.loads(cpu.read_text()), json.loads(mps.read_text())
        if first["status"] == second["status"] == "completed":
            result["backendAgreement"] = backend_agreement(first, second)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = {"schemaVersion": 1, "samples": {p.name: audit_sample(p) for p in sorted(args.root.iterdir()) if (p / "prepare.json").exists()}}
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(args.output)
    print(json.dumps({name: {stage: value["status"] for stage, value in data["stages"].items()} for name, data in result["samples"].items()}))


if __name__ == "__main__":
    main()
