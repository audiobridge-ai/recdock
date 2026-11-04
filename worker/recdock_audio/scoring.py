"""CER/WER for a complete, human-reviewed reference; never treats ASR output as truth."""

import argparse
import json
from pathlib import Path
import re
import unicodedata


def units(text: str, language: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold()
    if language == "zh":
        return [c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P")]
    if language == "en":
        return re.findall(r"[^\W_]+(?:['’][^\W_]+)*", text)
    raise ValueError("SCORING_LANGUAGE_UNSUPPORTED")


def error_rate(reference: str, hypothesis: str, language: str) -> dict:
    expected, actual = units(reference, language), units(hypothesis, language)
    if not expected:
        raise ValueError("EMPTY_REFERENCE")
    row = list(range(len(actual) + 1))
    for i, token in enumerate(expected, 1):
        next_row = [i]
        for j, other in enumerate(actual, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (token != other)))
        row = next_row
    return {"metric": "CER" if language == "zh" else "WER", "edits": row[-1],
            "referenceUnits": len(expected), "hypothesisUnits": len(actual), "rate": row[-1] / len(expected),
            "normalization": "nfkc_casefold_punctuation_v1", "numberNormalization": "none"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--asr", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text())
    hypothesis = json.loads(args.asr.read_text())
    if reference.get("humanReviewed") is not True or reference.get("coverage") != "whole_recording":
        raise SystemExit("HUMAN_REVIEWED_WHOLE_REFERENCE_REQUIRED")
    if reference.get("sourceSha256") != hypothesis["sourceSha256"] or reference.get("durationMs") != hypothesis["durationMs"]:
        raise SystemExit("REFERENCE_SOURCE_MISMATCH")
    if hypothesis["status"] != "completed":
        raise SystemExit("ASR_NOT_COMPLETE")
    actual = " ".join(c["text"] for c in hypothesis["chunks"])
    result = {"sourceSha256": reference["sourceSha256"], "referenceRevision": reference["revision"],
              **error_rate(reference["text"], actual, reference["language"])}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
