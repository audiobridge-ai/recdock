#!/usr/bin/env python3
"""Build a self-contained Apple Silicon companion from locally prepared, locked runtimes."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[1]
WEB = PROJECT.parent / 'plaud-web'
MAGICS = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
SYSTEM = ('/usr/lib/', '/System/Library/', '/Library/Apple/System/')


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, text=True, capture_output=True, **kwargs).stdout


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''): h.update(data)
    return h.hexdigest()


def macho(path):
    if not path.is_file() or path.is_symlink(): return False
    with path.open('rb') as stream: return stream.read(4) in MAGICS


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination, follow_symlinks=True)


def copy_tree(source, destination):
    shutil.copytree(source, destination, symlinks=False, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store', '.git', '.venv'))


def dependencies(path):
    identities = run(['/usr/bin/otool', '-D', path]).splitlines()[1:]
    return [line.strip().split(' (compatibility')[0] for line in run(['/usr/bin/otool', '-L', path]).splitlines()[1:] if line.strip().split(' (compatibility')[0] not in identities]


def rpaths(path):
    lines = run(['/usr/bin/otool', '-l', path]).splitlines()
    return [lines[i + 2].strip().split('path ', 1)[1].split(' (offset')[0] for i, line in enumerate(lines) if line.strip() == 'cmd LC_RPATH']


def relocate(resources, origins):
    runtime = resources / 'runtime'
    copied = {original.resolve(): target for target, original in origins.items() if target.is_file()}
    queue = [p for p in runtime.rglob('*') if macho(p)]
    scanned = set()
    minimum = (14, 0)
    for file in queue:
        if file in scanned: continue
        scanned.add(file)
        original = origins.get(file, file)
        load = run(['/usr/bin/otool', '-l', file])
        for version in re.findall(r'\bminos (\d+(?:\.\d+)+)', load):
            minimum = max(minimum, tuple(int(x) for x in version.split('.')))
        for dependency in dependencies(file):
            if dependency.startswith(SYSTEM): continue
            if dependency.startswith('@loader_path/'):
                bundled = file.parent / dependency.removeprefix('@loader_path/')
                if bundled.exists() and bundled.resolve().is_relative_to(resources.resolve()): continue
            if dependency.startswith('@rpath/'):
                name = dependency.removeprefix('@rpath/')
                bundled = [Path(p.replace('@loader_path', str(file.parent))) / name for p in rpaths(file)]
                if any(p.exists() and p.resolve().is_relative_to(resources.resolve()) for p in bundled): continue
            candidate = None
            if dependency.startswith('/'):
                candidate = Path(dependency)
            elif dependency.startswith('@loader_path/'):
                candidate = original.parent / dependency.removeprefix('@loader_path/')
            elif dependency.startswith('@executable_path/'):
                candidate = runtime / 'python/bin' / dependency.removeprefix('@executable_path/')
                if candidate.exists() and candidate.resolve().is_relative_to(resources.resolve()): continue
            elif dependency.startswith('@rpath/'):
                name = dependency.removeprefix('@rpath/')
                if name.startswith('libswift'): continue  # macOS supplies the Swift ABI libraries.
                roots = [Path(p.replace('@loader_path', str(original.parent))) for p in rpaths(original)]
                roots += [original.parent, Path('/opt/homebrew/lib'), runtime / 'python/lib', runtime / 'python/lib/python3.11/site-packages/torch/lib']
                candidate = next((root / name for root in roots if (root / name).exists()), None)
            if candidate is None or not candidate.exists():
                raise RuntimeError(f'Unresolved dynamic library in {file.relative_to(resources)}: {dependency}')
            resolved = candidate.resolve()
            if str(resolved).startswith(SYSTEM): continue
            if resolved.is_relative_to(resources.resolve()):
                target = resolved
            elif resolved in copied:
                target = copied[resolved]
            else:
                target = runtime / 'lib' / (hashlib.sha256(str(resolved).encode()).hexdigest()[:10] + '-' + resolved.name)
                copy_file(resolved, target)
                copied[resolved] = target; origins[target] = resolved; queue.append(target)
            replacement = '@loader_path/' + os.path.relpath(target, file.parent)
            if dependency != replacement: run(['/usr/bin/install_name_tool', '-change', dependency, replacement, file])
    for file in scanned:
        for dependency in dependencies(file):
            if dependency.startswith('/') and not dependency.startswith(SYSTEM): raise RuntimeError('External runtime dependency remains: ' + dependency)
    return '.'.join(str(x) for x in minimum), scanned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=PROJECT / 'dist')
    parser.add_argument('--web-origin', default='https://recdock-plaud-web-chentiansabers-projects.vercel.app')
    parser.add_argument('--node', type=Path, default=Path(shutil.which('node') or ''))
    parser.add_argument('--python', type=Path, default=WEB / 'worker/.venv/bin/python')
    parser.add_argument('--ffmpeg', type=Path, default=Path(shutil.which('ffmpeg') or ''))
    parser.add_argument('--ffprobe', type=Path, default=Path(shutil.which('ffprobe') or ''))
    parser.add_argument('--identity', default='-', help='Developer ID Application identity, or - for local ad-hoc testing')
    parser.add_argument('--notary-profile', help='Existing notarytool Keychain profile; no credentials are accepted here')
    parser.add_argument('--dmg', action='store_true')
    args = parser.parse_args()
    print('Validating build inputs', flush=True)
    if sys.platform != 'darwin' or run(['/usr/bin/uname', '-m']).strip() != 'arm64': raise SystemExit('Build requires an Apple Silicon Mac')
    if args.notary_profile and args.identity == '-': raise SystemExit('Notarization requires a Developer ID Application identity')
    if args.identity != '-' and 'Developer ID Application:' not in args.identity: raise SystemExit('Use a Developer ID Application identity')
    from urllib.parse import urlsplit
    origin = urlsplit(args.web_origin)
    if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username: raise SystemExit('web-origin must be an exact HTTPS origin')
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    app = output / 'RecDock.app'
    if app.exists(): raise SystemExit('Output App already exists; choose a new output directory to preserve previous builds')
    contents = app / 'Contents'; resources = contents / 'Resources'; binary = contents / 'MacOS/RecDock'
    resources.mkdir(parents=True); binary.parent.mkdir()
    workspace = resources / 'workspace'; workspace.mkdir()
    for directory in ['src', 'server', 'contracts']:
        copy_tree(WEB / directory, workspace / directory)
    compiled = output / 'compiled-javascript'
    run([args.node, WEB / 'node_modules/typescript/bin/tsc', '--project', WEB / 'tsconfig.json', '--noEmit', 'false', '--outDir', compiled, '--rewriteRelativeImportExtensions', 'true'])
    for directory in ['src', 'server']:
        copy_tree(compiled / directory, workspace / directory)
    for file in workspace.rglob('*.ts'): file.unlink()
    for file in ['package.json', 'package-lock.json']: copy_file(WEB / file, workspace / file)
    copy_tree(WEB / 'worker/recdock_audio', workspace / 'worker/recdock_audio')
    for file in ['pyproject.toml', 'requirements-macos-arm64.lock', 'MODEL-NOTICES.md']:
        copy_file(WEB / 'worker' / file, workspace / 'worker' / file)
    lock = json.loads((WEB / 'package-lock.json').read_text())
    for path, info in lock['packages'].items():
        if path and not info.get('dev') and not info.get('optional'):
            copy_tree(WEB / path, workspace / path)
    runtime = resources / 'runtime'; runtime.mkdir()
    print('Copying embedded runtimes', flush=True)
    copy_file(args.node.resolve(), runtime / 'node')
    node_version = run([runtime / 'node', '--version']).strip()
    if not node_version.startswith('v22.'): raise SystemExit('Node 22 is required')
    python_info = json.loads(run([args.python, '-c', 'import json,sys,sysconfig;print(json.dumps({"base":sys.base_prefix,"site":sysconfig.get_paths()["purelib"],"version":sys.version.split()[0]}))']))
    if not python_info['version'].startswith('3.11.'): raise SystemExit('The locked worker requires Python 3.11')
    origins = {}
    base = Path(python_info['base']).resolve()
    copy_tree(base, runtime / 'python')
    site = Path(python_info['site'])
    destination = runtime / 'python/lib/python3.11/site-packages'
    copy_tree(site, destination)
    # RecDock decodes through its bundled FFmpeg and passes PCM tensors to
    # pyannote. Wheels also ship optional FFmpeg 4–7 bridges that cannot load
    # against the bundled FFmpeg 8; do not ship broken, unused decoder plugins.
    excluded_plugins = []
    for pattern in ['torio/lib/*ffmpeg*', 'torchcodec/libtorchcodec*', 'torchaudio/lib/*sox*']:
        for file in destination.glob(pattern):
            if file.is_file(): excluded_plugins.append(str(file.relative_to(destination))); file.unlink()
    for directory in [runtime / 'python', destination]:
        for file in directory.rglob('*'):
            if file.name.startswith('__editable__') or file.name in ['_virtualenv.pth', '_virtualenv.py', 'direct_url.json']:
                if file.is_file(): file.unlink()
    for file in (runtime / 'python').rglob('*'):
        relative = file.relative_to(runtime / 'python')
        if str(relative).startswith('lib/python3.11/site-packages/'):
            original = site / file.relative_to(destination) if file.is_relative_to(destination) else base / relative
        else: original = base / relative
        if file.is_file(): origins[file] = original.resolve()
    for name, source in [('ffmpeg', args.ffmpeg), ('ffprobe', args.ffprobe)]:
        target = runtime / 'bin' / name; copy_file(source.resolve(), target); origins[target] = source.resolve()
    print('Resolving embedded dynamic libraries', flush=True)
    minimum, machos = relocate(resources, origins)
    print('Compiling native app and helpers (macOS '+minimum+')', flush=True)
    cache = output / 'module-cache'; cache.mkdir()
    common = ['-swift-version', '5', '-O', '-target', 'arm64-apple-macos' + minimum, '-module-cache-path', cache]
    run(['/usr/bin/swiftc', *common, '-framework', 'AppKit', '-framework', 'ServiceManagement', '-framework', 'Security', *sorted((PROJECT / 'Sources').glob('*.swift')), '-o', binary])
    helpers = resources / 'native'; helpers.mkdir()
    run(['/usr/bin/swiftc', *common, WEB / 'server/native/FileLock.swift', '-o', helpers / 'FileLock'])
    scanner = helpers / 'BroadcastScanner.app/Contents'
    (scanner / 'MacOS').mkdir(parents=True)
    copy_file(WEB / 'server/native/BroadcastScanner.plist', scanner / 'Info.plist')
    run(['/usr/bin/swiftc', *common, WEB / 'server/native/BroadcastScanner.swift', '-framework', 'CoreBluetooth', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', scanner / 'Info.plist', '-o', scanner / 'MacOS/BroadcastScanner'])
    plist = {'CFBundleExecutable':'RecDock','CFBundleIdentifier':'ai.recdock.companion','CFBundleName':'RecDock','CFBundleDisplayName':'RecDock 本地助手','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.2.0','CFBundleVersion':'2','LSUIElement':True,'LSMinimumSystemVersion':minimum,'NSBluetoothAlwaysUsageDescription':'用于识别你选择的 PLAUD 录音设备。','NSLocalNetworkUsageDescription':'用于让 RecDock 网页连接这台 Mac 上的录音服务。','NSAppTransportSecurity':{'NSAllowsLocalNetworking':True},'CFBundleURLTypes':[{'CFBundleURLName':'RecDock','CFBundleURLSchemes':['recdock']}]}
    (contents / 'Info.plist').write_bytes(plistlib.dumps(plist))
    config = {'version':'0.2.0','webOrigin':args.web_origin,'minimumMacOS':minimum,'architecture':'arm64','distribution':'local-ad-hoc' if args.identity == '-' else 'developer-id','runtime':{'node':node_version,'python':python_info['version']}}
    (resources / 'companion.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
    notices = resources / 'Licenses'; notices.mkdir()
    copy_file(PROJECT.parent / 'LICENSE', notices / 'RecDock-LICENSE')
    copy_file(WEB / 'worker/MODEL-NOTICES.md', notices / 'MODEL-NOTICES.md')
    (notices / 'THIRD-PARTY.md').write_text('''# Included runtime components\n\nNode.js (MIT and bundled third-party notices), python-build-standalone CPython (Python license and bundled notices), Python packages (their dist-info license files), npm packages (their license files), and FFmpeg with its dynamic dependencies.\n\nThe local build uses the FFmpeg installed on the build machine; its configuration, version, and dependency origins are recorded in runtime-build.json. It may be GPL-enabled. Public redistribution requires the matching notices and corresponding-source obligations to be fulfilled; a Developer ID signature does not resolve those obligations. Models are downloaded separately and their original notices are retained.\n''')
    for pattern in ['LICENSE*', 'COPYING*']:
        for file in base.glob(pattern):
            if file.is_file(): copy_file(file, notices / ('Python-' + file.name))
    node_root = args.node.resolve().parents[1]
    for file in node_root.glob('LICENSE*'):
        if file.is_file(): copy_file(file, notices / ('Node-' + file.name))
    brew_sources = {}
    for original in set(origins.values()):
        if '/opt/homebrew/Cellar/' in str(original):
            parts = original.parts; index = parts.index('Cellar'); formula = parts[index+1]; version = parts[index+2]
            prefix = Path(*parts[:index+3]); brew_sources[formula] = version
            for pattern in ['COPYING*', 'LICENSE*']:
                for file in prefix.glob(pattern):
                    if file.is_file(): copy_file(file, notices / (formula + '-' + file.name))
    build = {**config,'ffmpeg':run([args.ffmpeg.resolve(),'-version']).splitlines()[:3], 'homebrewComponents':brew_sources,'excludedOptionalDecoderPlugins':excluded_plugins,'publicDistributionReady':False,'notarized':False}
    (resources / 'runtime-build.json').write_text(json.dumps(build,ensure_ascii=False,indent=2)+'\n')
    # Sign modified embedded code individually; avoid --deep signing.
    all_machos = [p for p in app.rglob('*') if macho(p)]
    print('Signing '+str(len(all_machos))+' embedded executables for local testing' if args.identity == '-' else 'Signing Developer ID build', flush=True)
    options = [] if args.identity == '-' else ['--options','runtime','--timestamp']
    node_entitlements = output / 'node.entitlements.plist'
    node_entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True}))
    for file in sorted(all_machos, key=lambda p: len(p.parts), reverse=True):
        entitlements = ['--entitlements', node_entitlements] if file == runtime / 'node' else []
        run(['/usr/bin/codesign','--force','--sign',args.identity,*options,*entitlements,file])
    run(['/usr/bin/codesign','--force','--sign',args.identity,*options,helpers/'BroadcastScanner.app'])
    run(['/usr/bin/codesign','--force','--sign',args.identity,*options,app])
    run(['/usr/bin/codesign','--verify','--deep','--strict',app])
    # Verify relocation with a developer-tool-free PATH and isolated Python.
    print('Verifying isolated embedded runtimes', flush=True)
    env = {'PATH':str(runtime/'bin')+':/usr/bin:/bin','HOME':str(Path.home()),'PYTHONPATH':str(workspace/'worker'),'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','XDG_CACHE_HOME':str(output/'smoke-cache')}
    run([runtime/'python/bin/python3.11','-c','import sys,jsonschema,torch,huggingface_hub;print(sys.version)'], env=env)
    run([runtime/'bin/ffprobe','-version'],env=env)
    run([runtime/'node','--input-type=module','-e',"new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0])); await import("+json.dumps((workspace/'server/application.js').as_uri())+"); console.log('SERVICE_IMPORTS_OK')"],env=env)
    archive = output / 'RecDock-0.2.0-macos-arm64.zip'
    print('Creating installation archive', flush=True)
    run(['/usr/bin/ditto','-c','-k','--sequesterRsrc','--keepParent',app,archive])
    if args.notary_profile:
        run(['/usr/bin/xcrun','notarytool','submit',archive,'--keychain-profile',args.notary_profile,'--wait'])
        run(['/usr/bin/xcrun','stapler','staple',app]);run(['/usr/bin/xcrun','stapler','validate',app])
        archive.unlink();run(['/usr/bin/ditto','-c','-k','--sequesterRsrc','--keepParent',app,archive])
    if args.dmg:
        image = output / 'RecDock-0.2.0-macos-arm64.dmg'
        staging = output/'dmg-content';staging.mkdir();copy_tree(app,staging/'RecDock.app');(staging/'Applications').symlink_to('/Applications')
        run(['/usr/bin/hdiutil','create','-volname','RecDock','-srcfolder',staging,'-format','UDZO',image])
    manifest = {**config,'app':str(app),'archive':str(archive),'archiveSha256':digest(archive),'notarized':bool(args.notary_profile),'publicDistributionReady':False,'minimumMacOS':minimum,'machoFiles':len(all_machos)}
    (output / 'build-result.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(manifest,ensure_ascii=False,indent=2),flush=True)


if __name__ == '__main__':
    try: main()
    except subprocess.CalledProcessError as error:
        print('Build command failed: '+str(error.cmd),file=sys.stderr)
        print(error.stdout or '',file=sys.stderr);print(error.stderr or '',file=sys.stderr);raise SystemExit(error.returncode)
