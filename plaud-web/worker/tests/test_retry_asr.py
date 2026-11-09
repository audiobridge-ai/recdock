import importlib.metadata
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import wave

from recdock_audio.retry_asr import recover_chunk, suspect_text, usable_chunk
from recdock_audio.resume import prepared_matches, stage_matches
from recdock_audio.preflight import sha256


def audio(path: Path, frames: int, rate: int = 100):
    with wave.open(str(path), "wb") as target:
        target.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        target.writeframes(b"\x00\x00" * frames)


class RetryTests(unittest.TestCase):
    def test_loop_detection_preserves_ordinary_repeated_speech(self):
        self.assertTrue(suspect_text("嗯。" * 1000))
        self.assertFalse(suspect_text("对，对，对。下面我们继续讨论第二个方案。"))

    def test_shorter_retry_preserves_every_source_frame_and_offset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio(root / "chunk.wav", 6500)
            parent = {"id": "chunk_1", "path": "chunk.wav", "startFrame": 10000, "frameCount": 6500, "startMs": 100000, "endMs": 165000}

            def generate(path, **kwargs):
                if Path(path).name == "0-3000.wav":
                    return SimpleNamespace(text="嗯。" * 1000, generation_tokens=2048)
                return SimpleNamespace(text="有效片段", generation_tokens=4)

            result = recover_chunk(parent, root, SimpleNamespace(generate=generate), "Chinese")
            self.assertFalse(result["tokenLimitReached"])
            leaves = result["recoverySubchunks"]
            self.assertEqual(sum(c["frameCount"] for c in leaves), 6500)
            self.assertEqual([c["startMs"] for c in leaves], [100000, 110000, 120000, 130000, 160000])
            self.assertEqual(leaves[-1]["endMs"], parent["endMs"])
            self.assertTrue(usable_chunk(result, parent))

    def test_unresolved_five_second_audio_is_not_silently_dropped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio(root / "chunk.wav", 500)
            parent = {"id": "chunk_1", "path": "chunk.wav", "startFrame": 0, "frameCount": 500, "startMs": 0, "endMs": 5000}
            model = SimpleNamespace(generate=lambda *a, **k: SimpleNamespace(text="嗯。" * 1000, generation_tokens=2048))
            result = recover_chunk(parent, root, model, "Chinese")
            self.assertTrue(result["tokenLimitReached"])
            self.assertEqual(sum(c["frameCount"] for c in result["recoverySubchunks"]), 500)
            self.assertFalse(usable_chunk(result, parent))

    def test_source_change_invalidates_prepared_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["source.wav", "decoded.wav", "chunk.wav"]:
                audio(root / name, 500)
            chunk = {"id": "chunk_0", "path": "chunk.wav", "startFrame": 0, "frameCount": 500, "startMs": 0, "endMs": 5000}
            prepared = {"sourceSha256": sha256(root / "source.wav"), "sampleRate": 100, "decodedFrames": 500, "chunks": [chunk]}
            (root / "prepare.json").write_text(json.dumps(prepared))
            self.assertTrue(prepared_matches(root, root / "source.wav"))
            audio(root / "source.wav", 600)
            self.assertFalse(prepared_matches(root, root / "source.wav"))

    def test_model_and_asr_text_changes_invalidate_stage_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chunk = {"id": "chunk_0", "path": "chunk.wav", "startFrame": 0, "frameCount": 500, "startMs": 0, "endMs": 5000, "text": "你好", "tokenLimitReached": False}
            (root / "prepare.json").write_text(json.dumps({"sourceSha256": "s", "chunks": [chunk]}))
            models = root / "models"; models.mkdir()
            model = {"repo": "test/model", "revision": "r"}
            (models / "models.lock.json").write_text(json.dumps({"models": {"asr": {**model, "files": []}, "aligner": {**model, "files": []}}}))
            value = {"status": "completed", "sourceSha256": "s", "preparedSha256": sha256(root / "prepare.json"), "model": model, "language": "Chinese", "runtime": {"engineVersion": importlib.metadata.version("mlx-audio")}, "chunks": [chunk]}
            (root / "asr.json").write_text(json.dumps(value)); (root / "align.json").write_text(json.dumps(value))
            self.assertTrue(stage_matches(root, models, "align", "Chinese", "mps"))
            changed = json.loads(json.dumps(value)); changed["chunks"][0]["text"] = "再见"
            (root / "asr.json").write_text(json.dumps(changed))
            self.assertFalse(stage_matches(root, models, "align", "Chinese", "mps"))
            changed["model"] = {"repo": "test/model", "revision": "different"}
            (root / "asr.json").write_text(json.dumps(changed))
            self.assertFalse(stage_matches(root, models, "asr", "Chinese", "mps"))


if __name__ == "__main__":
    unittest.main()
