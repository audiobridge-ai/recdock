"""Resumable candidate downloads; model terms remain the user's responsibility."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time

# The SDK reads these settings at import time.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")

from .preflight import sha256

CANDIDATES = {
    "asr": "mlx-community/Qwen3-ASR-1.7B-8bit",
    "aligner": "mlx-community/Qwen3-ForcedAligner-0.6B-8bit",
    "diarizer": "pyannote/speaker-diarization-community-1",
}
PINNED_REVISIONS = {
    "mlx-community/Qwen3-ASR-1.7B-8bit": "a8379a2e2f9e313c9292cdf1af4055ab56d50d55",
    "mlx-community/Qwen3-ForcedAligner-0.6B-8bit": "0e1a68e91d815300c7c9754b2a7639378b23db15",
    "pyannote/speaker-diarization-community-1": "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee",
}


class ModelPreparationError(RuntimeError):
    def __init__(self, code: str, model: str, *, retryable: bool = False, error_type: str | None = None):
        super().__init__(code + ":" + model)
        self.code, self.model = code, model
        self.retryable, self.error_type = retryable, error_type

    def diagnostic(self) -> dict:
        # SDK exception strings may contain signed URLs or credentials.
        return {"code": self.code, "model": self.model, "retryable": self.retryable, "errorType": self.error_type}


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def _read(path: Path, default: dict) -> dict:
    return json.loads(path.read_text()) if path.is_file() else default


def _local_file(destination: Path, relative: str) -> Path:
    path = destination / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts or not path.resolve().is_relative_to(destination.resolve()):
        raise ValueError("UNSAFE_MODEL_PATH")
    return path


def cached_revision(destination: Path) -> str | None:
    paths = list((destination / ".cache/huggingface/trees").glob("*.json"))
    revisions = {p.stem for p in paths if re.fullmatch(r"[a-f0-9]{40}", p.stem)}
    return next(iter(revisions)) if len(revisions) == 1 else None


def expected_files(destination: Path, revision: str) -> dict | None:
    path = destination / ".cache/huggingface/trees" / (revision + ".json")
    if not path.is_file():
        return None
    tree = json.loads(path.read_text())
    if tree.get("format_version") != 1 or not isinstance(tree.get("files"), dict) or not tree["files"]:
        raise ValueError("MODEL_TREE_FORMAT_UNSUPPORTED")
    for relative in tree["files"]:
        _local_file(destination, relative)
    return tree["files"]


def verify_candidate(destination: Path, revision: str) -> list[dict]:
    """Validate against Hub commit metadata, not just hashes of whatever arrived."""
    expected = expected_files(destination, revision)
    if expected is None:
        raise ValueError("MODEL_TREE_MISSING")
    if not any(name.endswith((".safetensors", ".bin", ".pt")) for name in expected):
        raise ValueError("MODEL_WEIGHTS_MISSING")
    files = []
    for relative, metadata in sorted(expected.items()):
        path = _local_file(destination, relative)
        if not path.is_file() or path.stat().st_size != metadata["size"]:
            raise ValueError("MODEL_FILE_INCOMPLETE")
        digest = sha256(path)
        if metadata.get("lfs_sha256"):
            if digest != metadata["lfs_sha256"]:
                raise ValueError("MODEL_HASH_MISMATCH")
        else:
            blob = hashlib.sha1(f"blob {path.stat().st_size}\0".encode())
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    blob.update(chunk)
            if blob.hexdigest() != metadata.get("blob_id"):
                raise ValueError("MODEL_BLOB_MISMATCH")
        files.append({"path": relative, "bytes": metadata["size"], "sha256": digest})
    return files


def _classify(error: Exception, name: str) -> ModelPreparationError:
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status in (401, 403) or type(error).__name__ == "GatedRepoError":
        return ModelPreparationError("MODEL_ACCESS_DENIED", name, error_type=type(error).__name__)
    if status == 404 or type(error).__name__ == "RepositoryNotFoundError":
        return ModelPreparationError("MODEL_NOT_FOUND", name, error_type=type(error).__name__)
    return ModelPreparationError("MODEL_DOWNLOAD_FAILED", name, retryable=True, error_type=type(error).__name__)


def prepare(root: Path, *, attempts: int = 3, names: list[str] | None = None) -> dict:
    from huggingface_hub import HfApi, get_token, snapshot_download

    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = root / "models.lock.json"
    lock = _read(lock_path, {"schemaVersion": 1, "models": {}})
    pending_path = root / "pending-revisions.json"
    pending = _read(pending_path, {"schemaVersion": 1, "models": {}})
    token = get_token()
    api = HfApi()

    def state(name: str, phase: str, **fields) -> None:
        value = {"model": name, "phase": phase, "updatedAtMs": int(time.time() * 1000), **fields}
        _write(root / "prepare-state.json", value)
        print(json.dumps(value), flush=True)

    try:
        for name in names if names is not None else CANDIDATES:
            repo = CANDIDATES[name]
            destination = root / name
            saved = lock["models"].get(name)
            selected = pending["models"].get(name)
            revision = saved["revision"] if saved and saved["repo"] == repo else (
                selected["revision"] if selected and selected["repo"] == repo else cached_revision(destination) or PINNED_REVISIONS.get(repo)
            )
            if revision is None:
                try:
                    revision = api.model_info(repo, token=token if name == "diarizer" else False).sha
                except Exception as error:
                    raise _classify(error, name) from None
            if not re.fullmatch(r"[a-f0-9]{40}", revision or ""):
                raise ModelPreparationError("MODEL_REVISION_UNAVAILABLE", name)
            pending["models"][name] = {"repo": repo, "revision": revision}
            _write(pending_path, pending)
            state(name, "checking", revision=revision)
            expected = expected_files(destination, revision)
            complete = expected is not None and all(_local_file(destination, p).is_file() and _local_file(destination, p).stat().st_size == m["size"] for p, m in expected.items())
            if not complete:
                if name == "diarizer" and not token:
                    raise ModelPreparationError("HF_LOGIN_REQUIRED", name)
                for attempt in range(1, attempts + 1):
                    http = os.environ["HF_HUB_DISABLE_XET"].upper() in {"1", "ON", "YES", "TRUE"}
                    state(name, "downloading", revision=revision, attempt=attempt, transport="http" if http else "xet")
                    try:
                        snapshot_download(repo, revision=revision, local_dir=destination,
                                          token=token if name == "diarizer" else False, max_workers=1)
                        break
                    except Exception as error:
                        failure = _classify(error, name)
                        state(name, "retrying" if failure.retryable and attempt < attempts else "failed", **failure.diagnostic())
                        if not failure.retryable or attempt == attempts:
                            raise failure from None
                        time.sleep(min(attempt * 2, 6))
            state(name, "verifying", revision=revision)
            try:
                files = verify_candidate(destination, revision)
            except ValueError as error:
                raise ModelPreparationError(str(error), name) from None
            lock["models"][name] = {"repo": repo, "revision": revision, "files": files}
            _write(lock_path, lock)
            state(name, "ready", revision=revision, files=len(files))
    except ModelPreparationError as error:
        _write(root / "prepare.failure.json", error.diagnostic())
        raise
    (root / "prepare.failure.json").unlink(missing_ok=True)
    return lock


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--verify", action="store_true", help="Verify prepared models entirely offline")
    parser.add_argument("--only", action="append", choices=tuple(CANDIDATES), help="Prepare or verify one component independently")
    args = parser.parse_args()
    try:
        if args.verify:
            lock = json.loads((args.root / "models.lock.json").read_text())
            selected = set(args.only or CANDIDATES)
            if not selected.issubset(lock["models"]):
                raise ModelPreparationError("MODEL_SET_INCOMPLETE", "all")
            for name in selected:
                model = lock["models"][name]
                if model["repo"] != CANDIDATES[name]:
                    raise ModelPreparationError("MODEL_REPO_MISMATCH", name)
                actual = verify_candidate(args.root / name, model["revision"])
                if actual != model["files"]:
                    raise ModelPreparationError("MODEL_MANIFEST_MISMATCH", name)
        else:
            lock = prepare(args.root, names=args.only)
    except ModelPreparationError as error:
        print(json.dumps(error.diagnostic()), flush=True)
        raise SystemExit(2) from None
    except Exception as error:
        failure = {"code": "MODEL_PREPARATION_ERROR", "errorType": type(error).__name__}
        _write(args.root / "prepare.failure.json", failure)
        print(json.dumps(failure), flush=True)
        raise SystemExit(2) from None
    print(json.dumps({"models": {n: {"repo": m["repo"], "revision": m["revision"], "files": len(m["files"])} for n, m in lock["models"].items()}}))


if __name__ == "__main__":
    main()
