#!/usr/bin/env python3
"""Render the original vector artwork and assemble its PNG-based macOS icon family."""
from pathlib import Path
import struct
import subprocess

desktop = Path(__file__).resolve().parents[1]
assets = desktop / 'assets'
subprocess.run(['swift', '-module-cache-path', '/private/tmp/recdock-icon-swift-cache',
                str(desktop / 'scripts/create_icons.swift'), str(assets)], check=True)
chunks = []
for kind, name in [('icp4', '16x16'), ('icp5', '32x32'), ('icp6', '32x32@2x'),
                   ('ic07', '128x128'), ('ic08', '256x256'), ('ic09', '512x512'),
                   ('ic10', '512x512@2x'), ('ic11', '16x16@2x'),
                   ('ic12', '32x32@2x'), ('ic13', '128x128@2x'), ('ic14', '256x256@2x')]:
    data = (assets / 'RecDock.iconset' / ('icon_' + name + '.png')).read_bytes()
    chunks.append(kind.encode('ascii') + struct.pack('>I', len(data) + 8) + data)
payload = b''.join(chunks)
(assets / 'RecDock.icns').write_bytes(b'icns' + struct.pack('>I', len(payload) + 8) + payload)
print('Generated RecDock icon family and menu bar artwork.')
