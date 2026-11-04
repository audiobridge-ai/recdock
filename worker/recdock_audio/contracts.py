"""Shared JSON Schema and source-time invariants; no model imports or network access."""

from __future__ import annotations

import json
from pathlib import Path
from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "contracts/audio-v1.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
KINDS = ("Recording", "Transcript", "Job", "Revision", "Sync", "WorkerEvent", "WorkerCommand")


class AudioContractError(ValueError):
    code = "AUDIO_CONTRACT_INVALID"


def _fail(message: str) -> None:
    raise AudioContractError(message)


def _transcript(value: dict) -> None:
    duration = value["durationMs"]
    for collection in ("speakers", "chunks", "segments", "speakerTurns"):
        ids = [item["id"] for item in value[collection]]
        if len(ids) != len(set(ids)):
            _fail(collection + ": duplicate id")
    speakers = {s["id"] for s in value["speakers"]}
    chunks = {c["id"]: c for c in value["chunks"]}

    def span(item: dict, kind: str) -> None:
        if item["startMs"] >= item["endMs"] or item["endMs"] > duration:
            _fail(kind + ": invalid source time range")

    for chunk in chunks.values():
        span(chunk, "chunk")
        if chunk["paddingLeftMs"] > chunk["startMs"] or chunk["endMs"] + chunk["paddingRightMs"] > duration:
            _fail("chunk: padding exceeds source")
        if (chunk["status"] == "failed") != (chunk["errorCode"] is not None):
            _fail("chunk: inconsistent error")
    previous = -1
    for segment in value["segments"]:
        span(segment, "segment")
        if segment["startMs"] < previous:
            _fail("segments: not ordered by start time")
        previous = segment["startMs"]
        if segment["speakerId"] is not None and segment["speakerId"] not in speakers:
            _fail("segment: unknown speaker")
        if any(chunk_id not in chunks for chunk_id in segment["sourceChunkIds"]):
            _fail("segment: unknown source chunk")
        sources = [chunks[chunk_id] for chunk_id in segment["sourceChunkIds"]]
        ranges = sorted((c["startMs"] - c["paddingLeftMs"], c["endMs"] + c["paddingRightMs"]) for c in sources)
        covered = segment["startMs"]
        for start, end in ranges:
            if start <= covered:
                covered = max(covered, end)
        if covered < segment["endMs"]:
            _fail("segment: outside referenced chunks")
        word_start = -1
        for word in segment["words"]:
            start, end = word["startMs"], word["endMs"]
            if (start is None) != (end is None):
                _fail("word: incomplete timing")
            if word["timingSource"] == "unavailable":
                if start is not None:
                    _fail("word: unavailable timing must be null")
            elif start is None:
                _fail("word: missing timing")
            if start is not None and end is not None:
                if start < segment["startMs"] or end > segment["endMs"] or start >= end or start < word_start:
                    _fail("word: invalid source time range")
                word_start = start
        if segment["timingSource"] == "user_pending" and any(w["startMs"] is not None for w in segment["words"]):
            _fail("segment: pending edit retains stale word times")
    for turn in value["speakerTurns"]:
        span(turn, "speakerTurn")
        if turn["speakerId"] not in speakers:
            _fail("speakerTurn: unknown speaker")


def validate(kind: str, value: object) -> None:
    if kind not in KINDS:
        _fail("unknown contract kind")
    validator = Draft202012Validator({**SCHEMA, "$ref": "#/$defs/" + kind})
    error = next(validator.iter_errors(value), None)
    if error is not None:
        # Values may contain private transcript text: do not serialize rejected instances.
        _fail(kind + ": schema validation failed at /" + "/".join(str(x) for x in error.absolute_path))
    if kind == "Transcript":
        _transcript(value)
    elif kind == "WorkerEvent" and value["event"] == "progress":
        progress = value["payload"]
        if progress["totalUnits"] is not None and progress["completedUnits"] > progress["totalUnits"]:
            _fail("progress: exceeds total")
    elif kind == "WorkerCommand" and value["command"] == "run":
        limits = value["payload"]
        if limits["minSpeakers"] is not None and limits["maxSpeakers"] is not None and limits["minSpeakers"] > limits["maxSpeakers"]:
            _fail("speakers: invalid limits")
    elif kind == "Job":
        if (value["state"] == "running") != (value["stage"] is not None):
            _fail("job: state and stage disagree")
        if (value["state"] == "failed") != (value["error"] is not None):
            _fail("job: state and error disagree")
        if value["updatedAtMs"] < value["createdAtMs"]:
            _fail("job: timestamps reversed")
