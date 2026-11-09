"""Conservative reuse checks for this benchmark; no model imports or network."""

import argparse
import importlib.metadata
import json
from pathlib import Path
import wave

from .preflight import sha256
from .retry_asr import usable_chunk


def prepared_matches(output: Path, source: Path) -> bool:
    path = output / "prepare.json"
    if not path.exists():
        return False
    data = json.loads(path.read_text())
    if data["sourceSha256"] != sha256(source):
        return False
    decoded = output / "decoded.wav"
    if not decoded.is_file():
        return False
    with wave.open(str(decoded), "rb") as audio:
        if audio.getnframes() != data["decodedFrames"] or audio.getframerate() != data["sampleRate"]:
            return False
    for chunk in data["chunks"]:
        path = output / chunk["path"]
        if not path.is_file():
            return False
        with wave.open(str(path), "rb") as audio:
            if audio.getnframes() != chunk["frameCount"] or audio.getframerate() != data["sampleRate"]:
                return False
    return True


def stage_matches(output: Path, models: Path, stage: str, language: str, device: str) -> bool:
    path = output / (stage + ".json")
    if not path.exists():
        return False
    data = json.loads(path.read_text())
    prepared = json.loads((output / "prepare.json").read_text())
    selected = json.loads((models / "models.lock.json").read_text())["models"][{"asr": "asr", "align": "aligner", "diarize": "diarizer"}[stage]]
    model = {k: v for k, v in selected.items() if k != "files"}
    engine = "mlx-audio" if stage != "diarize" else "pyannote.audio"
    if data.get("status") != "completed" or data.get("sourceSha256") != prepared["sourceSha256"] or data.get("preparedSha256") != sha256(output / "prepare.json") or data.get("model") != model or data.get("runtime", {}).get("engineVersion") != importlib.metadata.version(engine):
        return False
    if stage == "diarize":
        return data.get("device") == device
    if data.get("language") != language:
        return False
    expected = {c["id"]: c for c in prepared["chunks"]}
    chunks = data.get("chunks", [])
    if len(chunks) != len(expected) or {c["id"] for c in chunks} != set(expected):
        return False
    if stage == "asr":
        return all(usable_chunk(c, expected[c["id"]]) for c in chunks)
    asr_path = output / "asr.json"
    if not asr_path.exists():
        return False
    asr = json.loads(asr_path.read_text())
    texts = {c["id"]: c["text"] for c in asr["chunks"]}
    return asr.get("status") == "completed" and all(c["text"] == texts.get(c["id"]) for c in chunks)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepared", "stage"))
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--stage", choices=("asr", "align", "diarize"))
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    try:
        ok = prepared_matches(args.output_dir, args.source) if args.mode == "prepared" else stage_matches(args.output_dir, args.models, args.stage, args.language, args.device)
    except (OSError, ValueError, KeyError):
        ok = False
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
