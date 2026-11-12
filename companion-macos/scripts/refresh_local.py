#!/usr/bin/env python3
"""Refresh local app code while retaining an already verified, unchanged runtime."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
from build import PROJECT, WEB, copy_tree, copy_file, digest, run


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--base',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    base=a.base.resolve();out=a.output.resolve();resources=base/'Contents/Resources'
    config=json.loads((resources/'companion.json').read_text())
    if config['distribution']!='local-ad-hoc':raise SystemExit('Only local ad-hoc builds can be refreshed')
    if (resources/'workspace/package-lock.json').read_bytes()!=(WEB/'package-lock.json').read_bytes():raise SystemExit('Dependency lock changed; run a full build')
    run(['/usr/bin/codesign','--verify','--deep','--strict',base])
    app=out/'RecDock.app'
    if out.exists():raise SystemExit('Choose a new output directory')
    out.mkdir(parents=True);print('Copying verified runtime',flush=True);copy_tree(base,app)
    r=app/'Contents/Resources';w=r/'workspace';compiled=out/'compiled-javascript'
    run([shutil.which('node'),WEB/'node_modules/typescript/bin/tsc','--project',WEB/'tsconfig.json','--noEmit','false','--outDir',compiled,'--rewriteRelativeImportExtensions','true'])
    for name in ['src','server']:
        shutil.rmtree(w/name);copy_tree(compiled/name,w/name)
    copy_tree(WEB/'worker/recdock_audio',w/'worker/recdock_audio')
    for name in ['package.json','package-lock.json']:copy_file(WEB/name,w/name)
    cache=PROJECT/'dist/module-cache';cache.mkdir(exist_ok=True)
    print('Compiling refreshed app',flush=True)
    executable=app/'Contents/MacOS/RecDock'
    run(['/usr/bin/swiftc','-swift-version','5','-O','-target','arm64-apple-macos'+config['minimumMacOS'],'-module-cache-path',cache,'-framework','AppKit','-framework','ServiceManagement','-framework','Security',*sorted((PROJECT/'Sources').glob('*.swift')),'-o',executable])
    run(['/usr/bin/codesign','--force','--sign','-',executable]);run(['/usr/bin/codesign','--force','--sign','-',app]);run(['/usr/bin/codesign','--verify','--deep','--strict',app])
    archive=out/'RecDock-0.2.0-macos-arm64.zip'
    print('Creating refreshed installation archive',flush=True)
    run(['/usr/bin/ditto','-c','-k','--sequesterRsrc','--keepParent',app,archive])
    result={**config,'app':str(app),'archive':str(archive),'archiveSha256':digest(archive),'notarized':False,'publicDistributionReady':False,'runtimeReusedFrom':str(base),'sourceRefresh':True}
    (out/'build-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)


if __name__=='__main__':main()
