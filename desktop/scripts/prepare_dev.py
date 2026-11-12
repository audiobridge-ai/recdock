#!/usr/bin/env python3
"""Prepare standard Electron development mode without re-signing the runtime for each source edit."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'desktop'

def run(args, **kwargs):
    subprocess.run([str(p) for p in args], check=True, **kwargs)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resources', required=True, type=Path)
    parser.add_argument('--electron-zip', type=Path)
    parser.add_argument('--refresh-launcher', action='store_true')
    args = parser.parse_args()
    electron = DESKTOP / 'node_modules/electron/dist/Electron.app'
    if not electron.exists():
        if not args.electron_zip:
            raise SystemExit('Run npm ci, or pass the official Electron archive')
        from build_macos import extract_electron
        extract_electron(args.electron_zip, electron.parent)
        (electron.parent.parent / 'path.txt').write_text('Electron.app/Contents/MacOS/Electron')
    workspace = DESKTOP / 'vendor/dev-workspace'
    workspace.mkdir(parents=True, exist_ok=True)
    (DESKTOP / 'vendor/dev-runtime.json').write_text(json.dumps({'resources': str(args.resources.resolve())}) + '\n')
    run(['npm', 'run', 'build'], cwd=ROOT / 'plaud-web')
    run([shutil.which('node'), ROOT / 'plaud-web/node_modules/typescript/bin/tsc', '--project', ROOT / 'plaud-web/tsconfig.json', '--noEmit', 'false', '--outDir', workspace, '--rewriteRelativeImportExtensions', 'true'])
    (workspace / 'package.json').write_text(json.dumps({'type':'module'}) + '\n')
    for name in ['worker', 'node_modules', 'contracts']:
        target = workspace / name
        if not target.exists():
            target.symlink_to(ROOT / 'plaud-web' / name, target_is_directory=True)
    launcher = DESKTOP / 'vendor/RecDock Dev.app'
    if launcher.exists() and not args.refresh_launcher:
        print('Development launcher already exists; existing executables were kept.')
        return
    macos = launcher / 'Contents/MacOS'; macos.mkdir(parents=True, exist_ok=True)
    plist = {'CFBundleExecutable':'RecDockDev','CFBundleIdentifier':'ai.recdock.development-launcher','CFBundleName':'RecDock Dev','CFBundleDisplayName':'RecDock 开发启动器','CFBundlePackageType':'APPL','LSUIElement':True,'RecDockElectron':str(electron),'RecDockProject':str(DESKTOP),'RecDockResources':str(args.resources.resolve())}
    (launcher / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
    cache = DESKTOP / 'vendor/swift-cache'; cache.mkdir(exist_ok=True)
    run(['/usr/bin/swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos13.0', '-module-cache-path', cache, '-framework', 'AppKit', DESKTOP / 'scripts/dev_launcher.swift', '-o', macos / 'RecDockDev'])
    run(['/usr/bin/codesign', '--force', '--sign', '-', launcher])
    print('Prepared development launcher:', launcher)

if __name__ == '__main__':
    main()
