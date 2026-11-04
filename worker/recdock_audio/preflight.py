"""Read-only, stdlib-only environment and source-audio diagnostics."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

SAMPLES = {
    "zh-short": "0-four-speakers-zh.wav",
    "en-short": "3-two-speakers-en.wav",
    "zh-long": "02-24周会录音-飞飞.mp3",
    "en-long": "Steve Jobs & Bill Gates_ A Conversation That Shaped Technology.mp3",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hardware() -> dict:
    result = {"system": platform.system(), "release": platform.release(), "machine": platform.machine()}
    if platform.system() == "Darwin":
        proc = subprocess.run(
            ["/usr/sbin/system_profiler", "SPHardwareDataType"], capture_output=True, text=True, timeout=30
        )
        # Whitelist fields: never copy the profiler's serial number or UUID.
        names = {"Model Name": "model", "Chip": "chip", "Memory": "memory", "Total Number of Cores": "cores"}
        for line in proc.stdout.splitlines():
            key, separator, value = line.strip().partition(":")
            if separator and key in names:
                result[names[key]] = value.strip()
    return result


def environment(workspace: Path, accelerators: bool = False) -> dict:
    packages = {}
    for name in ("mlx-audio", "mlx", "pyannote.audio", "torch", "torchaudio", "huggingface-hub", "jsonschema"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    tools = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe", "uv", "node")}
    disk = shutil.disk_usage(workspace)
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface"))
    credentials_available = bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")) or (hf_home / "token").is_file()
    blockers = []
    if not ((3, 11) <= sys.version_info[:2] < (3, 13)):
        blockers.append("PYTHON_VERSION_UNSUPPORTED")
    if not tools["ffmpeg"] or not tools["ffprobe"]:
        blockers.append("FFMPEG_MISSING")
    for name in ("mlx-audio", "pyannote.audio", "jsonschema"):
        if packages[name] is None:
            blockers.append("PACKAGE_MISSING:" + name)
    output = {
        "schemaVersion": 1, "hardware": hardware(), "python": platform.python_version(),
        "packages": packages, "tools": tools, "freeDiskBytes": disk.free,
        "hfCredentialAvailable": credentials_available, "blockers": blockers,
    }
    if accelerators:
        output["accelerators"] = {}
        for name, code in {
            "mlx": "import mlx.core as mx; x=mx.array([1.,2.]); mx.eval(x*x); print(mx.default_device())",
            "torchMps": "import torch; print(torch.backends.mps.is_available())",
        }.items():
            try:
                proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=45)
                output["accelerators"][name] = {"returncode": proc.returncode, "output": proc.stdout.strip()[:300]}
                if proc.returncode:
                    output["accelerators"][name]["error"] = proc.stderr[-1500:]
                    if name == "mlx":
                        blockers.append("MLX_DEVICE_UNAVAILABLE")
            except subprocess.TimeoutExpired:
                output["accelerators"][name] = {"error": "PROBE_TIMEOUT"}
                blockers.append("ACCELERATOR_PROBE_TIMEOUT:" + name)
    return output


def inspect_sample(path: Path, decode: bool = False) -> dict:
    start = time.monotonic()
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_name,sample_rate,channels:format=duration,size,format_name", "-of", "json", str(path),
    ], capture_output=True, text=True, timeout=60)
    if probe.returncode:
        raise RuntimeError("FFPROBE_FAILED:" + probe.stderr[-500:])
    output = {"sha256": sha256(path), "bytes": path.stat().st_size, "audio": json.loads(probe.stdout)}
    if decode:
        decoded = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "null", "-"],
                                 capture_output=True, text=True, timeout=1800)
        output["decode"] = {"returncode": decoded.returncode, "error": decoded.stderr[-1000:] or None}
    output["elapsedSeconds"] = round(time.monotonic() - start, 3)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("environment", "samples"))
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--decode", action="store_true")
    parser.add_argument("--accelerators", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "environment":
        result = environment(args.workspace, args.accelerators)
    else:
        if args.source_dir is None:
            parser.error("samples requires --source-dir")
        result = {"schemaVersion": 1, "samples": {}}
        for sample_id, filename in SAMPLES.items():
            path = args.source_dir / filename
            try:
                result["samples"][sample_id] = inspect_sample(path, args.decode)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                result["samples"][sample_id] = {"error": str(error)}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
