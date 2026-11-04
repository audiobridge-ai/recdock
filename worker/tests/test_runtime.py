import contextlib
import io
import json
from types import SimpleNamespace
import unittest

from recdock_audio.runtime import Runtime, canonical_transcript, bound_diarization


class RuntimeTests(unittest.TestCase):
    def test_small_speaker_endpoint_overshoot_is_bounded_without_changing_model_artifact(self):
        raw = {"turns": [{"startMs": 7017, "endMs": 8013, "speakerId": "SPEAKER_00"}], "exclusiveTurns": []}
        bounded, adjusted = bound_diarization(raw, 8000)
        self.assertEqual(bounded["turns"][0]["endMs"], 8000)
        self.assertEqual(raw["turns"][0]["endMs"], 8013)
        self.assertEqual(adjusted, [(7017, 8000)])
        raw["turns"][0]["endMs"] = 8041
        with self.assertRaisesRegex(ValueError, "REVIEW_SPEAKER_TIME_OUTSIDE_SOURCE"):
            bound_diarization(raw, 8000)

    def test_wholly_outside_small_tail_is_removed_and_invalid_ranges_are_rejected(self):
        result, _ = bound_diarization({"turns": [{"startMs": 8001, "endMs": 8013, "speakerId": "SPEAKER_00"}], "exclusiveTurns": []}, 8000)
        self.assertEqual(result["turns"], [])
        for start, end in [(100, 100), (200, 100), (-41, 20), (0, float("nan"))]:
            with self.assertRaises(ValueError):
                bound_diarization({"turns": [{"startMs": start, "endMs": end}], "exclusiveTurns": []}, 8000)

    def test_canonical_transcript_binds_original_not_playable_hash_and_keeps_uncertainty(self):
        chunk = {"id": "chunk_a", "startMs": 0, "endMs": 2000, "startFrame": 0, "frameCount": 32000, "text": "Hello world."}
        prepared = {"sourceSha256": "b" * 64, "durationMs": 2000, "chunks": [chunk]}
        stage = {"status": "completed", "sourceSha256": "b" * 64, "durationMs": 2000, "chunks": [chunk], "language": "English", "model": {"repo": "synthetic", "revision": "test"}}
        align = {**stage, "chunks": [{**chunk, "words": [{"text": "Hello", "startMs": 100, "endMs": 100}, {"text": "world", "startMs": 500, "endMs": 1000}]}]}
        diarized = {**stage, "turns": [], "exclusiveTurns": []}
        result = canonical_transcript({"id": "rec_test", "title": "test", "sourceSha256": "a" * 64}, prepared, stage, align, diarized, "c" * 64)
        self.assertEqual(result["sourceSha256"], "a" * 64)
        self.assertIsNone(result["segments"][0]["speakerId"])
        self.assertIn("unaligned", result["segments"][0]["flags"])
        self.assertEqual(result["segments"][0]["words"], [])
        self.assertEqual("".join(s["text"] for s in result["segments"]), chunk["text"])

    def test_protocol_is_json_lines_with_sequence_job_identity_and_valid_progress(self):
        runtime = Runtime(SimpleNamespace(), {"jobId": "job_test"})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            runtime.event("ready", {"workerVersion": "test", "capabilities": ["preparing"]})
            runtime.event("stage_started", {"inputFingerprint": "a" * 64}, "preparing")
            runtime.event("progress", {"completedUnits": 1, "totalUnits": 2, "unit": "steps"}, "preparing")
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([v["sequence"] for v in values], [1, 2, 3])
        self.assertIsNone(values[0]["jobId"])
        self.assertEqual(values[1]["jobId"], "job_test")
        with self.assertRaises(ValueError):
            runtime.event("progress", {"completedUnits": 3, "totalUnits": 2, "unit": "steps"}, "preparing")
