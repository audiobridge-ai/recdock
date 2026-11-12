#!/usr/bin/env python3
"""Verify a completed App and record existing installation artifacts after packaging."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess

from build_macos import ELECTRON_VERSION, ELECTRON_ARM64_SHA256, minimum_os, sha

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()
root = args.directory.resolve()
app = root / 'RecDock.app'
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
package = json.loads((app / 'Contents/Resources/app/package.json').read_text())
signature = subprocess.run(['codesign', '-dv', str(app)], capture_output=True, text=True, check=True).stderr
files = [p for p in app.rglob('*') if p.is_file() and not p.is_symlink()]
result = {'version': package['version'], 'platform': 'macos-arm64', 'minimumMacOS': plist['LSMinimumSystemVersion'],
          'electron': ELECTRON_VERSION, 'electronArchiveSha256': ELECTRON_ARM64_SHA256,
          'distribution': 'local-ad-hoc' if 'Signature=adhoc' in signature else 'signed-unverified-identity',
          'notarized': False, 'machOCount': sum(minimum_os(p) is not None for p in files),
          'app': str(app), 'appBytes': sum(p.stat().st_size for p in files), 'signatureVerified': True}
checksums = []
for kind, suffix in [('archive', 'zip'), ('dmg', 'dmg')]:
    path = root / f'RecDock-{package["version"]}-macos-arm64.{suffix}'
    if path.exists():
        if kind == 'dmg':
            subprocess.run(['hdiutil', 'verify', str(path)], check=True)
        digest = sha(path)
        result.update({kind: str(path), kind + 'Bytes': path.stat().st_size, kind + 'Sha256': digest})
        checksums.append(digest + '  ' + path.name)
(root / 'build-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
(root / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
