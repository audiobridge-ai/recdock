#!/usr/bin/env python3
"""Build the desktop release candidate using a verified self-contained runtime."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import stat
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'desktop'
WEB = ROOT / 'plaud-web'
ELECTRON_VERSION = '45.3.1'
ELECTRON_ARM64_SHA256 = 'ed40f8473a3c62a7c0463bd42f6724ccb8d5919cfdc64e0d9f65f61bdb3fe4d2'

def run(args, **kwargs):
    result = subprocess.run([str(a) for a in args], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    return result.stdout

def sha(path):
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()

def copy(source, target):
    def source_file(origin, destination):
        shutil.copyfile(origin, destination)
        shutil.copymode(origin, destination)
        return destination
    shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True, copy_function=source_file, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store', '.pytest_cache'))

def extract_electron(archive, destination):
    if sha(archive) != ELECTRON_ARM64_SHA256:
        raise SystemExit('Electron archive SHA-256 does not match the official release.')
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            parts = Path(member.filename).parts
            if member.filename.startswith('/') or '..' in parts:
                raise SystemExit('Unsafe Electron archive path')
            if not parts or parts[0] == '__MACOSX' or parts[-1] == '.DS_Store':
                continue
            target = destination / member.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = member.external_attr >> 16
            if member.is_dir():
                target.mkdir(exist_ok=True)
            elif stat.S_ISLNK(mode):
                link = source.read(member).decode('utf8')
                resolved = (target.parent / link).resolve()
                if Path(link).is_absolute() or not str(resolved).startswith(str(destination.resolve()) + os.sep):
                    raise SystemExit('Unsafe Electron archive symlink')
                target.symlink_to(link)
            else:
                with source.open(member) as data, target.open('wb') as output:
                    shutil.copyfileobj(data, output)
                target.chmod(stat.S_IMODE(mode) or 0o644)

def minimum_os(path):
    with path.open('rb') as stream:
        header = stream.read(32)
        if len(header) < 32 or header[:4] != b'\xcf\xfa\xed\xfe':
            return None
        result = None
        for _ in range(struct.unpack_from('<I', header, 16)[0]):
            command, size = struct.unpack('<II', stream.read(8))
            payload = stream.read(size - 8)
            value = struct.unpack_from('<I', payload, 4)[0] if command == 0x32 else struct.unpack_from('<I', payload, 0)[0] if command == 0x24 else None
            if value:
                result = max(result or (0, 0, 0), (value >> 16, value >> 8 & 255, value & 255))
        return result

def rebase_audio_tools(resources, tools):
    runtime = resources / 'runtime'
    old_libs = {p.name: p.name.split('-lib', 1)[-1] for p in (runtime / 'lib').glob('*.dylib') if '-lib' in p.name}
    shutil.rmtree(runtime / 'lib')
    (runtime / 'lib').mkdir()
    install = tools / 'install'
    for path in (install / 'lib').glob('*.dylib'):
        target = runtime / 'lib' / path.name
        if path.is_symlink():
            target.symlink_to(os.readlink(path))
        else:
            shutil.copy2(path, target)
    for name in ['ffmpeg', 'ffprobe']:
        (runtime / 'bin' / name).chmod(0o755)
        shutil.copy2(install / 'bin' / name, runtime / 'bin' / name)
    candidates = [runtime / 'bin/ffmpeg', runtime / 'bin/ffprobe']
    candidates += [p for p in runtime.rglob('*') if not p.is_symlink() and p.suffix in {'.so', '.dylib'}]
    for path in candidates:
        if not minimum_os(path):
            continue
        path.chmod(path.stat().st_mode | 0o200)
        libraries = run(['/usr/bin/otool', '-L', path]).splitlines()[1:]
        for line in libraries:
            dependency = line.strip().split(' (', 1)[0]
            name = Path(dependency).name
            target_name = ('lib' + old_libs[name]) if name in old_libs else name
            target = runtime / 'lib' / target_name
            if path.resolve() == target.resolve() and path.parent == runtime / 'lib':
                continue
            if target.exists() and (str(install) in dependency or name in old_libs or name.startswith(('libav', 'libsw'))):
                replacement = '@loader_path/' + os.path.relpath(target, path.parent)
                run(['/usr/bin/install_name_tool', '-change', dependency, replacement, path])
        if path.parent == runtime / 'lib':
            run(['/usr/bin/install_name_tool', '-id', '@rpath/' + path.name, path])
    notices = resources / 'Licenses'
    for path in notices.iterdir():
        if path.name.startswith(('ffmpeg-', 'x264-', 'x265-', 'svt-av1-', 'libvpx-', 'opus-', 'dav1d-', 'lame-')) or path.name == 'THIRD-PARTY.md':
            path.unlink()
    source = tools / 'FFmpeg-n8.0.1'
    for name in ['COPYING.LGPLv2.1', 'LICENSE.md']:
        shutil.copy2(source / name, notices / ('FFmpeg-' + name))
    shutil.copy2(tools / 'build-manifest.json', notices / 'FFmpeg-build.json')
    shutil.copy2(tools / 'FFmpeg-n8.0.1-source.tar.gz', notices / 'FFmpeg-n8.0.1-source.tar.gz')
    shutil.copy2(DESKTOP / 'scripts/build_audio_tools.py', notices / 'FFmpeg-build.py')
    (notices / 'FFmpeg-source.txt').write_text('FFmpeg n8.0.1 source: https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.0.1.tar.gz\nSHA-256: 679aa13a19415d5ddab91e580084e3ab20c963c8240001e5cbb955a97bdd81b1\nRecDock build instructions: desktop/scripts/build_audio_tools.py\nThis build does not enable GPL components or external codec libraries.\n')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-app', type=Path, default=ROOT / 'companion-macos/dist/local-2026-11-11-i/RecDock.app')
    parser.add_argument('--electron-zip', type=Path)
    parser.add_argument('--audio-tools', type=Path, required=True, help='Shared FFmpeg audio build produced by build_audio_tools.py')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--identity', default='-')
    parser.add_argument('--archive', action='store_true')
    parser.add_argument('--dmg', action='store_true')
    args = parser.parse_args()
    out = args.output.resolve()
    if out.exists():
        raise SystemExit('Use a new output directory; existing artifacts are never overwritten.')
    for path in [args.audio_tools / 'FFmpeg-n8.0.1-source.tar.gz', args.audio_tools / 'build-manifest.json', DESKTOP / 'assets/RecDock.icns']:
        if not path.is_file():
            raise SystemExit('Required build input is missing: ' + str(path))
    base = args.runtime_app.resolve()
    if not base.is_dir():
        raise SystemExit('Build the self-contained runtime with companion-macos/scripts/build.py first, or pass --runtime-app.')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', base])
    base_resources = base / 'Contents/Resources'
    if (base_resources / 'workspace/package-lock.json').read_bytes() != (WEB / 'package-lock.json').read_bytes():
        raise SystemExit('Web runtime dependency lock changed; rebuild the self-contained runtime before packaging.')
    out.mkdir(parents=True)
    print('Building packaged workspace', flush=True)
    run(['npm', 'run', 'build'], cwd=WEB)
    compiled = out / 'compiled'
    run([shutil.which('node'), WEB / 'node_modules/typescript/bin/tsc', '--project', WEB / 'tsconfig.json', '--noEmit', 'false', '--outDir', compiled, '--rewriteRelativeImportExtensions', 'true'])
    app = out / 'RecDock.app'
    if args.electron_zip:
        archive = args.electron_zip.resolve()
        extracted = out / 'electron'
        extract_electron(archive, extracted)
        shutil.move(extracted / 'Electron.app', app)
    else:
        electron = DESKTOP / 'node_modules/electron/dist/Electron.app'
        if not electron.is_dir():
            raise SystemExit('Install desktop dependencies, or supply the official --electron-zip.')
        copy(electron, app)
    resources = app / 'Contents/Resources'
    (resources / 'default_app.asar').unlink(missing_ok=True)
    print('Copying standalone runtimes and application', flush=True)
    for name in ['runtime', 'native', 'Licenses']:
        copy(base_resources / name, resources / name)
    if args.audio_tools:
        print('Embedding the audio-only FFmpeg build and updating Python audio bindings', flush=True)
        rebase_audio_tools(resources, args.audio_tools.resolve())
    workspace = resources / 'workspace'
    workspace.mkdir()
    for name in ['src', 'server']:
        copy(compiled / name, workspace / name)
    for name in ['contracts', 'node_modules']:
        copy(base_resources / 'workspace' / name, workspace / name)
    copy(WEB / 'worker/recdock_audio', workspace / 'worker/recdock_audio')
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(WEB / name, workspace / name)
    copy(WEB / 'dist', resources / 'public')
    copy(WEB / 'extensions/chatgpt-bridge', resources / 'extension')
    copy(DESKTOP / 'assets', resources / 'branding')
    shutil.copy2(DESKTOP / 'assets/RecDock.icns', resources / 'RecDock.icns')
    source = resources / 'app'
    copy(DESKTOP / 'src', source / 'src')
    package = json.loads((DESKTOP / 'package.json').read_text())
    (source / 'package.json').write_text(json.dumps({k: package[k] for k in ['name', 'productName', 'version', 'main', 'license']}, indent=2) + '\n')
    (source / 'src/native-host.sh').chmod(0o755)
    shutil.copy2(ROOT / 'LICENSE', resources / 'Licenses/RecDock-MIT.txt')
    shutil.copy2(WEB / 'worker/MODEL-NOTICES.md', resources / 'Licenses/Models.md')
    if args.electron_zip:
        for name in ['LICENSE', 'LICENSES.chromium.html', 'version']:
            path = out / 'electron' / name
            if path.exists():
                shutil.copy2(path, resources / 'Licenses' / ('Electron-' + name))
    executable = app / 'Contents/MacOS/Electron'
    executable.rename(app / 'Contents/MacOS/RecDock')
    # Read embedded build requirements instead of claiming an untested older system.
    machos = []
    minimum = (13, 0, 0)
    for path in app.rglob('*'):
        if path.is_file() and not path.is_symlink():
            version = minimum_os(path)
            if version:
                minimum = max(minimum, version)
                machos.append(path)
    min_string = '.'.join(map(str, minimum)).removesuffix('.0')
    plist_path = app / 'Contents/Info.plist'
    plist = plistlib.loads(plist_path.read_bytes())
    plist.update(CFBundleExecutable='RecDock', CFBundleName='RecDock', CFBundleDisplayName='RecDock', CFBundleIdentifier='ai.recdock.desktop', CFBundleShortVersionString=package['version'].split('-')[0], CFBundleVersion=package['buildNumber'], LSMinimumSystemVersion=min_string,
                 CFBundleDevelopmentRegion='en', CFBundleLocalizations=['en', 'zh-Hans'], NSBluetoothAlwaysUsageDescription='Connect to your selected PLAUD device to read status and download recordings.', NSBluetoothPeripheralUsageDescription='Connect to the recording device you select.', NSLocalNetworkUsageDescription='Access the RecDock recording processing service on this computer.', NSHighResolutionCapable=True)
    for locale in (DESKTOP / 'locales').glob('*.lproj'):
        copy(locale, resources / locale.name)
    plist.pop('ElectronTeamID', None)
    plist['CFBundleIconFile'] = 'RecDock.icns'
    plist_path.write_bytes(plistlib.dumps(plist))
    entitlements = out / 'entitlements.plist'
    entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit': True, 'com.apple.security.cs.allow-unsigned-executable-memory': True}))
    print(f'Signing {len(machos)} embedded Mach-O files; minimum macOS {min_string}', flush=True)
    sign = ['/usr/bin/codesign', '--force', '--sign', args.identity]
    if args.identity != '-':
        sign += ['--timestamp', '--options', 'runtime']
    for path in sorted(machos, key=lambda p: len(p.parts), reverse=True):
        run([*sign, '--entitlements', entitlements, path])
    bundles = sorted([p for p in app.rglob('*') if p.is_dir() and p.suffix in {'.app', '.framework'}], key=lambda p: len(p.parts), reverse=True)
    for path in bundles:
        run([*sign, '--entitlements', entitlements, path])
    run([*sign, '--entitlements', entitlements, app])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    result = {'version': package['version'], 'platform': 'macos-arm64', 'minimumMacOS': min_string, 'electron': ELECTRON_VERSION, 'electronArchiveSha256': ELECTRON_ARM64_SHA256,
              'distribution': 'local-ad-hoc' if args.identity == '-' else 'developer-id', 'notarized': False, 'machOCount': len(machos), 'app': str(app), 'appBytes': sum(p.stat().st_size for p in app.rglob('*') if p.is_file() and not p.is_symlink())}
    def record():
        (out / 'build-result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    record()
    if args.archive:
        print('Creating ZIP installation archive', flush=True)
        archive = out / f'RecDock-{package["version"]}-macos-arm64.zip'
        run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
        result.update(archive=str(archive), archiveBytes=archive.stat().st_size, archiveSha256=sha(archive))
        record()
    if args.dmg:
        staging = out / 'disk-image'; staging.mkdir()
        copy(app, staging / 'RecDock.app'); (staging / 'Applications').symlink_to('/Applications')
        dmg = out / f'RecDock-{package["version"]}-macos-arm64.dmg'
        run(['/usr/bin/hdiutil', 'create', '-volname', 'RecDock', '-srcfolder', staging, '-format', 'UDZO', '-ov', dmg])
        result.update(dmg=str(dmg), dmgBytes=dmg.stat().st_size, dmgSha256=sha(dmg))
        record()
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)

if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout, file=sys.stderr)
        print(error.stderr, file=sys.stderr)
        raise
