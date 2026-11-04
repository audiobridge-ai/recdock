from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from recdock_audio import models

REVISION = "a" * 40


def write_model(destination: Path, revision: str = REVISION) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    files = {"config.json": b'{"test":true}', "model.safetensors": b"synthetic-weight-bytes"}
    tree = {}
    for name, data in files.items():
        (destination / name).write_bytes(data)
        entry = {"size": len(data), "blob_id": hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()}
        if name.endswith(".safetensors"):
            entry["lfs_sha256"] = hashlib.sha256(data).hexdigest()
        tree[name] = entry
    cache = destination / ".cache/huggingface/trees"
    cache.mkdir(parents=True)
    (cache / (revision + ".json")).write_text(json.dumps({"format_version": 1, "files": tree}))


class ModelTests(unittest.TestCase):
    def test_hub_hashes_and_same_length_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_model(root)
            self.assertEqual(len(models.verify_candidate(root, REVISION)), 2)
            weight = root / "model.safetensors"
            weight.write_bytes(b"x" * weight.stat().st_size)
            with self.assertRaisesRegex(ValueError, "MODEL_HASH_MISMATCH"):
                models.verify_candidate(root, REVISION)

    def test_small_git_blob_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_model(root)
            config = root / "config.json"
            config.write_bytes(b"x" * config.stat().st_size)
            with self.assertRaisesRegex(ValueError, "MODEL_BLOB_MISMATCH"):
                models.verify_candidate(root, REVISION)

    def test_model_tree_cannot_escape_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_model(root)
            path = root / ".cache/huggingface/trees" / (REVISION + ".json")
            value = json.loads(path.read_text())
            value["files"]["../../other.bin"] = {"size": 1}
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "UNSAFE_MODEL_PATH"):
                models.verify_candidate(root, REVISION)

    def test_download_retries_same_revision_without_leaking_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            api = SimpleNamespace(model_info=Mock(return_value=SimpleNamespace(sha=REVISION)))
            attempts = []

            def download(repo, **kwargs):
                attempts.append(kwargs)
                if len(attempts) == 1:
                    raise RuntimeError("failed https://example.invalid?signature=private hf_secret")
                write_model(kwargs["local_dir"], kwargs["revision"])

            sdk = SimpleNamespace(HfApi=lambda: api, get_token=lambda: None, snapshot_download=download)
            output = io.StringIO()
            with patch.dict(sys.modules, {"huggingface_hub": sdk}), patch.dict(models.CANDIDATES, {"asr": "test/model"}, clear=True), patch.object(models.time, "sleep"), redirect_stdout(output):
                result = models.prepare(root)
            self.assertEqual([x["revision"] for x in attempts], [REVISION, REVISION])
            self.assertEqual([x["max_workers"] for x in attempts], [1, 1])
            self.assertEqual(result["models"]["asr"]["revision"], REVISION)
            self.assertNotIn("private", output.getvalue())
            self.assertNotIn("hf_secret", output.getvalue())
            self.assertEqual(json.loads((root / "prepare-state.json").read_text())["phase"], "ready")

    def test_failed_first_download_keeps_commit_for_later_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            api = SimpleNamespace(model_info=Mock(return_value=SimpleNamespace(sha=REVISION)))
            sdk = SimpleNamespace(HfApi=lambda: api, get_token=lambda: None,
                                  snapshot_download=Mock(side_effect=RuntimeError("network failed")))
            with patch.dict(sys.modules, {"huggingface_hub": sdk}), patch.dict(models.CANDIDATES, {"asr": "test/model"}, clear=True), redirect_stdout(io.StringIO()):
                with self.assertRaises(models.ModelPreparationError):
                    models.prepare(root, attempts=1)
                pending = json.loads((root / "pending-revisions.json").read_text())
                self.assertEqual(pending["models"]["asr"]["revision"], REVISION)
                api.model_info.side_effect = AssertionError("must not resolve main again")
                sdk.snapshot_download = lambda repo, **kwargs: write_model(kwargs["local_dir"], kwargs["revision"])
                models.prepare(root)
            self.assertFalse((root / "prepare.failure.json").exists())

    def test_access_denied_is_not_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            denied = RuntimeError("private error")
            denied.response = SimpleNamespace(status_code=403)
            download = Mock(side_effect=denied)
            sdk = SimpleNamespace(HfApi=lambda: SimpleNamespace(model_info=lambda *a, **k: SimpleNamespace(sha=REVISION)),
                                  get_token=lambda: "local-test-token", snapshot_download=download)
            with patch.dict(sys.modules, {"huggingface_hub": sdk}), patch.dict(models.CANDIDATES, {"diarizer": "test/model"}, clear=True), redirect_stdout(io.StringIO()):
                with self.assertRaises(models.ModelPreparationError) as context:
                    models.prepare(root)
            self.assertEqual(context.exception.code, "MODEL_ACCESS_DENIED")
            self.assertEqual(download.call_count, 1)
            self.assertNotIn("private error", (root / "prepare.failure.json").read_text())

    def test_complete_cache_needs_neither_network_nor_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_model(root / "diarizer")
            forbidden = Mock(side_effect=AssertionError("no network expected"))
            sdk = SimpleNamespace(HfApi=lambda: SimpleNamespace(model_info=forbidden), get_token=lambda: None, snapshot_download=forbidden)
            with patch.dict(sys.modules, {"huggingface_hub": sdk}), patch.dict(models.CANDIDATES, {"diarizer": "test/model"}, clear=True), redirect_stdout(io.StringIO()):
                result = models.prepare(root)
            self.assertEqual(result["models"]["diarizer"]["revision"], REVISION)
            forbidden.assert_not_called()

    def test_one_component_can_complete_while_other_models_are_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_model(root / "asr")
            forbidden = Mock(side_effect=AssertionError("no unrelated model should be requested"))
            sdk = SimpleNamespace(HfApi=lambda: SimpleNamespace(model_info=forbidden), get_token=lambda: None, snapshot_download=forbidden)
            with patch.dict(sys.modules, {"huggingface_hub": sdk}), redirect_stdout(io.StringIO()):
                result = models.prepare(root, names=["asr"])
            self.assertEqual(set(result["models"]), {"asr"})
            forbidden.assert_not_called()


if __name__ == "__main__":
    unittest.main()
