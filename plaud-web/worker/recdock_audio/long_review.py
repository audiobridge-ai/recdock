"""Build an offline, private long-recording review bundle and full-text exports."""

import argparse
import json
from pathlib import Path
import re
import shutil

from .benchmark import write_json
from .paragraphs import merge_recording
from .preflight import sha256

SAMPLES = [
    ("zh-long", "02-24周会录音-飞飞", "中文周会", "zh", "02-24周会录音-飞飞.mp3"),
    ("en-long", "Steve Jobs & Bill Gates: A Conversation That Shaped Technology", "Jobs 与 Gates 访谈", "en", "Steve Jobs & Bill Gates_ A Conversation That Shaped Technology.mp3"),
]
ISSUES = {
    "many_zero_or_invalid_word_times": "词时间缺失较多", "word_time_outside_source": "词时间越界",
    "nonmonotonic_word_times": "词时间顺序异常", "no_positive_word_interval": "仅有源片段时间",
    "speaker_uncertain": "讲话人待确认", "multiple_speakers_in_paragraph": "可能包含换人",
    "overlapping_speech": "可能有重叠讲话", "ALIGNMENT_TEXT_MAPPING_MISMATCH": "文字与对齐未匹配",
    "ALIGNMENT_TEXT_CHANGED": "文字与对齐版本不一致",
    "long_internal_gap": "段内时间间隔较大", "unusually_long_word_span": "词跨度异常偏长",
}


def timestamp(ms: int, precise: bool = False) -> str:
    seconds, millis = divmod(ms, 1000)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}" + (f".{millis:03}" if precise else "")


def export_text(recording: dict, markdown: bool = True) -> str:
    def safe(value):
        return re.sub(r"([\\`*_{}\[\]<>#|])", r"\\\1", value) if markdown else value
    header = ["# " + safe(recording["title"]) if markdown else recording["title"],
              "来源 SHA-256：" + recording["sourceSha256"], "时长：" + timestamp(recording["durationMs"]),
              f"核对状态：0/{len(recording['paragraphs'])} 段已由使用者标记核对。",
              "自动转写候选稿；讲话人编号仅在本录音内有效。时间为模型估计；仅有源片段时间的段落会单独标注。未经核对的文字、归属和定位可能有误。",
              "回答时请引用录音标题、讲话人与时间范围；原文未提供的信息请说明无法确定。"]
    names = {s["id"]: s["name"] for s in recording["speakers"]}
    paragraphs = []
    for p in recording["paragraphs"]:
        flags = ["待核对"] + (["仅有源片段时间"] if p["timing"] == "source_chunk_only" else []) + [ISSUES.get(x, x) for x in p["issues"]]
        paragraphs.append(("### " if markdown else "") + f"[{timestamp(p['startMs'], True)}–{timestamp(p['endMs'], True)}] " + safe(names.get(p["speakerId"], "讲话人待确认"))
                          + "\n" + "；".join(flags) + "\n\n" + safe(p["text"].strip()))
    return "\n\n".join(header) + "\n\n" + "\n\n".join(paragraphs) + "\n"


def review_targets(prepared: dict, sample_id: str) -> list[dict]:
    chunks = prepared["chunks"]
    n = len(chunks)
    indexes = [0, 44 if sample_id == "zh-long" and n > 44 else 1, n // 4, n // 2, 3 * n // 4, n - 2, n - 1]
    return [{"chunkId": chunks[i]["id"], "startMs": chunks[i]["startMs"], "endMs": chunks[i]["endMs"]} for i in sorted(set(indexes))]


def render_html(recordings: list[dict]) -> str:
    assets = Path(__file__).parent / "review_assets"
    template = (assets / "page.html").read_text()
    core = re.sub(r"^export (?=(?:const|function) )", "", (assets / "review-core.mjs").read_text(), flags=re.MULTILINE)
    script = core + "\n" + (assets / "review.js").read_text()
    data = json.dumps(recordings, ensure_ascii=False).replace("<", "\\u003c")
    return template.replace("__STYLE__", (assets / "review.css").read_text()).replace("__SCRIPT__", script).replace("__DATA__", data)


def build(root: Path, sources: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    audio = output / "audio"
    audio.mkdir(exist_ok=True, mode=0o700)
    recordings = []
    for sample_id, title, short_title, language, filename in SAMPLES:
        directory = root / sample_id
        artifacts = {name: json.loads((directory / f"{name}.json").read_text()) for name in ["prepare", "asr", "align", "diarize"]}
        source = sources / filename
        if sha256(source) != artifacts["prepare"]["sourceSha256"]:
            raise ValueError("REVIEW_PLAYBACK_SOURCE_HASH_MISMATCH")
        recording = merge_recording(artifacts["prepare"], artifacts["asr"], artifacts["align"], artifacts["diarize"],
                                    sample_id=sample_id, title=title, language=language,
                                    artifact_hashes={name: sha256(directory / f"{name}.json") for name in artifacts})
        recording.update(shortTitle=short_title, audio=f"audio/{sample_id}.mp3", reviewTargets=review_targets(artifacts["prepare"], sample_id))
        destination = output / recording["audio"]
        if not destination.exists() or sha256(destination) != recording["sourceSha256"]:
            shutil.copyfile(source, destination)
        destination.chmod(0o600)
        for suffix, contents in [("md", export_text(recording)), ("txt", export_text(recording, False))]:
            path = output / f"{sample_id}.transcript.{suffix}"
            path.write_text(contents, encoding="utf-8")
            path.chmod(0o600)
        write_json(output / f"{sample_id}.paragraphs.json", recording)
        recordings.append(recording)
    html = output / "index.html"
    html.write_text(render_html(recordings), encoding="utf-8")
    html.chmod(0o600)
    summary = {"schemaVersion": 1, "status": "candidate_ready_for_review", "humanAccuracyScored": False,
               "recordings": {r["id"]: {"sourceSha256": r["sourceSha256"], "fingerprint": r["fingerprint"],
                              "durationMs": r["durationMs"], **r["stats"], "reviewTargetMs": sum(t["endMs"] - t["startMs"] for t in r["reviewTargets"])} for r in recordings},
               "htmlBytes": html.stat().st_size}
    write_json(output / "manifest.json", summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.root, args.source_dir, args.output), ensure_ascii=False))


if __name__ == "__main__":
    main()
