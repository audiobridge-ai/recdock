"""Lossless candidate paragraphs from ASR, alignment and recording-wide speakers.

This is a review artifact, not a human reference or a production transcript.
No word timestamps are interpolated; uncertain intervals remain explicit.
"""

from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import re
import unicodedata


def normalize(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def word_spans(text: str, words: list[dict]) -> list[dict]:
    """Match normalized tokens exactly, retaining ALL original punctuation/space."""
    positions = []
    normalized = []
    for offset, char in enumerate(text):
        value = normalize(char)
        normalized.extend(value)
        positions.extend([offset] * len(value))
    target = "".join(normalized)
    tokens = [normalize(w["text"]) for w in words]
    if not words or any(not x for x in tokens) or "".join(tokens) != target:
        raise ValueError("ALIGNMENT_TEXT_MAPPING_MISMATCH")
    cursor = 0
    starts = []
    for token in tokens:
        starts.append(positions[cursor])
        cursor += len(token)
    starts[0] = 0
    ends = starts[1:] + [len(text)]
    return [{**w, "charStart": start, "charEnd": end} for w, start, end in zip(words, starts, ends)]


def overlap_ms(start: int, end: int, turn: dict) -> int:
    return max(0, min(end, turn["endMs"]) - max(start, turn["startMs"]))


def speaker_for_word(word: dict, turns: list[dict], lower: int, upper: int) -> str | None:
    start, end = word["startMs"], word["endMs"]
    if not lower <= start <= end <= upper:
        return None
    if start == end:
        matches = {t["speakerId"] for t in turns if t["startMs"] <= start < t["endMs"]}
        return next(iter(matches)) if len(matches) == 1 else None
    weights = defaultdict(int)
    for turn in turns:
        weights[turn["speakerId"]] += overlap_ms(start, end, turn)
    if not weights:
        return None
    speaker = max(weights, key=weights.get)
    return speaker if weights[speaker] >= (end - start) * .6 else None


def _paragraph(chunk: dict, words: list[dict], turns: list[dict], all_turns: list[dict], index: int) -> dict:
    lower, upper = chunk["startMs"], chunk["endMs"]
    issues = []
    valid = [w for w in words if lower <= w["startMs"] < w["endMs"] <= upper]
    points = [w for w in words if lower <= w["startMs"] <= w["endMs"] <= upper]
    if valid:
        start = min(w["startMs"] for w in points)
        end = max(w["endMs"] for w in points)
        timing = "model_estimate"
        if len(valid) / len(words) < .4:
            issues.append("many_zero_or_invalid_word_times")
        if len(points) != len(words):
            issues.append("word_time_outside_source")
        if any(a["startMs"] > b["startMs"] for a, b in zip(points, points[1:])):
            issues.append("nonmonotonic_word_times")
        if any(b["startMs"] - a["endMs"] > 3000 for a, b in zip(points, points[1:])):
            issues.append("long_internal_gap")
        if any(w["endMs"] - w["startMs"] > 5000 for w in valid):
            issues.append("unusually_long_word_span")
    else:
        start, end, timing = lower, upper, "source_chunk_only"
        issues.append("no_positive_word_interval")
    weights = defaultdict(int)
    for w in valid:
        for turn in turns:
            weights[turn["speakerId"]] += overlap_ms(w["startMs"], w["endMs"], turn)
    weights = {k: v for k, v in weights.items() if v}
    total = sum(weights.values())
    duration = sum(w["endMs"] - w["startMs"] for w in valid)
    winner = max(weights, key=weights.get) if weights else None
    share = weights[winner] / total if winner else 0
    coverage = total / duration if duration else 0
    speaker = winner if share >= .7 and coverage >= .5 and timing != "source_chunk_only" else None
    if speaker is None:
        issues.append("speaker_uncertain")
    elif share < .9:
        issues.append("multiple_speakers_in_paragraph")
    # Intersections of different raw speaker turns indicate overlap, not confidence.
    active = [t for t in all_turns if overlap_ms(start, end, t)]
    overlapped = any(a["speakerId"] != b["speakerId"] and min(end, a["endMs"], b["endMs"]) - max(start, a["startMs"], b["startMs"]) >= 150
                     for i, a in enumerate(active) for b in active[i + 1:])
    if overlapped:
        issues.append("overlapping_speech")
    char_start, char_end = words[0]["charStart"], words[-1]["charEnd"]
    return {"id": f"{chunk['id']}-p{index:03d}", "text": chunk["text"][char_start:char_end],
            "startMs": start, "endMs": end, "speakerId": speaker,
            "timing": timing, "issues": issues, "reviewed": False,
            "speakerCandidates": sorted([{"speakerId": k, "overlapMs": v} for k, v in weights.items()], key=lambda x: -x["overlapMs"]),
            "speakerAgreementRatio": round(share, 4), "speakerCoverageRatio": round(coverage, 4),
            "wordCount": len(words), "invalidWordCount": len(words) - len(valid),
            "source": {"chunkId": chunk["id"], "charStart": char_start, "charEnd": char_end,
                       "startMs": lower, "endMs": upper}}


def chunk_paragraphs(chunk: dict, aligned: dict, turns: list[dict], all_turns: list[dict], language: str) -> list[dict]:
    local = [t for t in turns if overlap_ms(chunk["startMs"], chunk["endMs"], t)]
    raw = [t for t in all_turns if overlap_ms(chunk["startMs"], chunk["endMs"], t)]
    try:
        if aligned.get("text") != chunk["text"]:
            raise ValueError("ALIGNMENT_TEXT_CHANGED")
        words = word_spans(chunk["text"], aligned["words"])
    except ValueError as error:
        return [{"id": f"{chunk['id']}-p000", "text": chunk["text"], "startMs": chunk["startMs"], "endMs": chunk["endMs"],
                 "speakerId": None, "timing": "source_chunk_only", "issues": [str(error), "speaker_uncertain"],
                 "reviewed": False, "wordCount": 0, "invalidWordCount": 0,
                 "speakerCandidates": [], "speakerAgreementRatio": 0, "speakerCoverageRatio": 0,
                 "source": {"chunkId": chunk["id"], "charStart": 0, "charEnd": len(chunk["text"]),
                            "startMs": chunk["startMs"], "endMs": chunk["endMs"]}}]
    labels = [speaker_for_word(w, local, chunk["startMs"], chunk["endMs"]) for w in words]
    # A stable speaker run can break a sentence; fleeting turns are kept and flagged.
    stable_changes = set()
    cursor = 0
    previous_known = None
    while cursor < len(words):
        stop = cursor + 1
        while stop < len(words) and labels[stop] == labels[cursor]:
            stop += 1
        if cursor and labels[cursor] is not None and previous_known is not None and labels[cursor] != previous_known and words[stop - 1]["endMs"] - words[cursor]["startMs"] >= 700:
            previous_fragment = chunk["text"][words[cursor - 1]["charStart"]:words[cursor - 1]["charEnd"]]
            if language != "zh" or re.search(r'[，,。！？!?；;、：:]\s*$', previous_fragment):
                stable_changes.add(cursor)
        if labels[cursor] is not None:
            previous_known = labels[cursor]
        cursor = stop
    groups = []
    begin = 0
    char_limit = 160 if language == "zh" else 520
    for i, word in enumerate(words):
        if i > begin and i in stable_changes:
            groups.append(words[begin:i])
            begin = i
        fragment = chunk["text"][word["charStart"]:word["charEnd"]]
        length = word["charEnd"] - words[begin]["charStart"]
        elapsed = word["endMs"] - words[begin]["startMs"]
        sentence_end = re.search(r'[。！？!?][”’\"\']*\s*$' if language == "zh" else r'[.!?][”’\"\']*\s*$', fragment)
        if sentence_end or (length >= char_limit and re.search(r'[，,；;、\s]$', fragment)) or elapsed >= 35000:
            groups.append(words[begin:i + 1])
            begin = i + 1
    if begin < len(words):
        groups.append(words[begin:])
    # Join a zero-only sentence with its neighbour instead of inventing duration.
    # Its original word times remain zero in the immutable alignment artifact.
    index = 0
    while index < len(groups):
        positive = any(chunk["startMs"] <= w["startMs"] < w["endMs"] <= chunk["endMs"] for w in groups[index])
        if not positive and len(groups) > 1:
            if index + 1 < len(groups):
                groups[index:index + 2] = [groups[index] + groups[index + 1]]
            else:
                groups[index - 1:index + 1] = [groups[index - 1] + groups[index]]
                index -= 1
        else:
            index += 1
    paragraphs = [_paragraph(chunk, group, local, raw, i) for i, group in enumerate(groups)]
    assert "".join(p["text"] for p in paragraphs) == chunk["text"]
    return paragraphs


def merge_recording(prepared: dict, asr: dict, aligned: dict, speakers: dict, *, sample_id: str, title: str, language: str, artifact_hashes: dict) -> dict:
    expected = {c["id"]: c for c in prepared["chunks"]}
    for stage in [asr, aligned, speakers]:
        if stage.get("status") != "completed" or stage.get("sourceSha256") != prepared["sourceSha256"] or stage.get("durationMs") != prepared["durationMs"]:
            raise ValueError("REVIEW_REQUIRES_COMPLETE_SAME_SOURCE_ARTIFACTS")
    for stage in [asr, aligned]:
        if len(stage["chunks"]) != len(expected) or {c["id"] for c in stage["chunks"]} != set(expected):
            raise ValueError("REVIEW_REQUIRES_ALL_SOURCE_CHUNKS")
        if any(any(c.get(k) != expected[c["id"]].get(k) for k in ("startMs", "endMs", "startFrame", "frameCount")) for c in stage["chunks"]):
            raise ValueError("REVIEW_SOURCE_TIMELINE_MISMATCH")
    for turn in speakers["turns"] + speakers["exclusiveTurns"]:
        if not 0 <= turn["startMs"] < turn["endMs"] <= prepared["durationMs"]:
            raise ValueError("REVIEW_SPEAKER_TIME_OUTSIDE_SOURCE")
    align_by_id = {c["id"]: c for c in aligned["chunks"]}
    paragraphs = []
    for chunk in asr["chunks"]:
        paragraphs.extend(chunk_paragraphs(chunk, align_by_id[chunk["id"]], speakers["exclusiveTurns"], speakers["turns"], language))
    first_seen = {}
    for turn in sorted(speakers["turns"], key=lambda t: t["startMs"]):
        first_seen.setdefault(turn["speakerId"], turn["startMs"])
    identities = []
    for index, (sid, start) in enumerate(first_seen.items()):
        exclusive = [t for t in speakers["exclusiveTurns"] if t["speakerId"] == sid]
        raw = [t for t in speakers["turns"] if t["speakerId"] == sid]
        preview = max(exclusive or raw, key=lambda t: t["endMs"] - t["startMs"])
        identities.append({"id": sid, "name": f"讲话人 {index + 1}", "firstSeenMs": start,
                           "speechMs": sum(t["endMs"] - t["startMs"] for t in exclusive), "turnCount": len(raw),
                           "previewStartMs": preview["startMs"], "previewEndMs": min(preview["endMs"], preview["startMs"] + 12000)})
    fingerprint = hashlib.sha256(json.dumps({"artifacts": artifact_hashes, "merger": "paragraph-review-v1", "paragraphs": paragraphs}, sort_keys=True).encode()).hexdigest()
    stats = {"paragraphs": len(paragraphs), "speakers": len(identities),
             "uncertainSpeakerParagraphs": sum(p["speakerId"] is None for p in paragraphs),
             "sourceChunkOnlyParagraphs": sum(p["timing"] == "source_chunk_only" for p in paragraphs),
             "flaggedParagraphs": sum(bool(p["issues"]) for p in paragraphs),
             "originalWordCount": sum(len(c["words"]) for c in aligned["chunks"]),
             "originalInvalidWordCount": sum(p["invalidWordCount"] for p in paragraphs)}
    return {"schemaVersion": 1, "artifactType": "recdock_paragraph_review", "id": sample_id, "title": title,
            "language": language, "durationMs": prepared["durationMs"], "sourceSha256": prepared["sourceSha256"],
            "fingerprint": fingerprint, "artifactHashes": artifact_hashes, "humanReviewed": False,
            "speakers": identities, "paragraphs": paragraphs, "stats": stats,
            "models": {"asr": asr["model"], "aligner": aligned["model"], "diarizer": speakers["model"]}}
