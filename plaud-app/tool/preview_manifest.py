"""Write public provenance for the experimental Android preview (no secrets)."""
import hashlib
import json
import os
from pathlib import Path
import sys

directory = Path(sys.argv[1])
apk, = directory.glob("*.apk")
manifest = {
    "product": "RecDock Mobile",
    "version": "0.3.1+4",
    "channel": "preview.1",
    "sourceCommit": os.environ["SOURCE_COMMIT"],
    "flutter": "3.27.4",
    "android": {
        "file": apk.name,
        "bytes": apk.stat().st_size,
        "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
        "signing": "debug certificate; experimental preview only",
        "upgradeCompatibility": "Not guaranteed between builds. Export important data before replacing an existing test installation.",
    },
    "ios": {
        "validation": "Unsigned iOS Simulator Debug build",
        "installableIpa": False,
        "reason": "No distribution signing identity or provisioning profile is configured.",
    },
}
(directory / "build-info.json").write_text(json.dumps(manifest, indent=2) + "\n")
