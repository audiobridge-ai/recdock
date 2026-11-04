from pathlib import Path
import json
import tempfile
import unittest

from recdock_audio.audit import audit_sample, backend_agreement


class AuditTests(unittest.TestCase):
    def test_backend_ids_are_permuted_before_comparison(self):
        def data(a, b):
            return {"sourceSha256": "same-source", "model": {"revision": "same-model"}, "exclusiveTurns": [
                {"startMs": 0, "endMs": 1000, "speakerId": a},
                {"startMs": 1000, "endMs": 2000, "speakerId": b}]}
        result = backend_agreement(data("SPEAKER_00", "SPEAKER_01"), data("SPEAKER_01", "SPEAKER_00"))
        self.assertEqual(result["agreement"], 1)
        self.assertIn("not_accuracy", result["metric"])

    def test_backend_missing_speech_is_not_agreement(self):
        first = {"sourceSha256": "s", "model": {}, "exclusiveTurns": [{"startMs": 0, "endMs": 2000, "speakerId": "a"}]}
        second = {**first, "exclusiveTurns": [{"startMs": 1000, "endMs": 2000, "speakerId": "b"}]}
        self.assertEqual(backend_agreement(first, second)["agreement"], 0.5)

    def test_completed_asr_cannot_omit_chunks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "prepare.json").write_text(json.dumps({"sourceSha256": "s", "durationMs": 1000, "chunks": [{"id": "chunk_0", "startMs": 0, "endMs": 1000, "startFrame": 0, "frameCount": 16000}]}))
            (root / "asr.json").write_text(json.dumps({"sourceSha256": "s", "status": "completed", "chunks": []}))
            result = audit_sample(root)
            self.assertIn("INCOMPLETE_CHUNK_COVERAGE", result["stages"]["asr"]["issues"])

    def test_zero_length_word_detected_even_if_model_marks_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chunk = {"id": "chunk_0", "startMs": 0, "endMs": 1000, "startFrame": 0, "frameCount": 16000}
            (root / "prepare.json").write_text(json.dumps({"sourceSha256": "s", "durationMs": 1000, "chunks": [chunk]}))
            (root / "align.json").write_text(json.dumps({"sourceSha256": "s", "status": "completed", "chunks": [{**chunk, "words": [{"startMs": 500, "endMs": 500, "validSourceRange": True}]}]}))
            result = audit_sample(root)
            self.assertEqual(result["stages"]["align"]["invalidWordCount"], 1)
            self.assertEqual(result["stages"]["align"]["invalidWords"][0]["reason"], "ZERO_DURATION")


if __name__ == "__main__":
    unittest.main()
