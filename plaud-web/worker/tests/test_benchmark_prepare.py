from pathlib import Path
import json
import tempfile
import unittest
import wave
import shutil
from unittest.mock import patch

from recdock_audio.benchmark import prepare, main


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
class PrepareTests(unittest.TestCase):
    def test_frame_offsets_and_final_partial_chunk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.wav"
            frames = 5 * 16000 + 123
            with wave.open(str(source), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\x00\x00" * frames)
            result = prepare(source, root / "output", 2)
            self.assertEqual([x["startFrame"] for x in result["chunks"]], [0, 32000, 64000])
            self.assertEqual(sum(x["frameCount"] for x in result["chunks"]), frames)
            self.assertEqual([x["startMs"] for x in result["chunks"]], [0, 2000, 4000])
            self.assertEqual(result["chunks"][-1]["endMs"], result["durationMs"])
            for chunk in result["chunks"]:
                with wave.open(str(root / "output" / chunk["path"]), "rb") as audio:
                    self.assertEqual(audio.getnframes(), chunk["frameCount"])

    def test_rejects_alignment_limit_before_decoding(self):
        with self.assertRaises(ValueError):
            prepare(Path("missing.wav"), Path("unused-output"), 300)

    def test_failed_stage_does_not_remain_running(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "prepare.json").write_text(json.dumps({"sourceSha256": "a" * 64, "durationMs": 1000, "chunks": []}))
            arguments = ["benchmark", "asr", "--output-dir", str(root), "--models", str(root / "missing-models")]
            with patch("sys.argv", arguments), self.assertRaises(FileNotFoundError):
                main()
            self.assertEqual(json.loads((root / "asr.json").read_text())["status"], "failed")
            self.assertEqual(json.loads((root / "asr.failure.json").read_text())["errorType"], "FileNotFoundError")


if __name__ == "__main__":
    unittest.main()
