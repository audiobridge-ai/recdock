#!/usr/bin/env python3
"""Build only the FFmpeg audio tools used by RecDock, without external codec libraries."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import tarfile

SOURCE_URL = 'https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.0.1.tar.gz'
SOURCE_SHA256 = '679aa13a19415d5ddab91e580084e3ab20c963c8240001e5cbb955a97bdd81b1'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--static', action='store_true', help='Build static tools instead of the shared libraries required by Python audio bindings')
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise SystemExit('FFmpeg source hash mismatch')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    with tarfile.open(args.source) as archive:
        if any(m.name.startswith('/') or '..' in Path(m.name).parts or m.issym() or m.islnk() for m in archive.getmembers()):
            raise SystemExit('Unsafe source archive')
        archive.extractall(output)
    source = output / 'FFmpeg-n8.0.1'
    # Upstream version.sh otherwise discovers RecDock's parent .git directory.
    # VERSION is its supported release-version override, independent of checkout location.
    (source / 'VERSION').write_text('8.0.1\n')
    configure = ['./configure', '--prefix=' + str(output / 'install'), '--cc=clang', '--disable-autodetect', *(['--disable-shared', '--enable-static'] if args.static else ['--enable-shared', '--disable-static']), '--disable-doc', '--disable-ffplay', '--disable-network', '--disable-avdevice', '--disable-debug', '--disable-everything',
                 '--enable-ffmpeg', '--enable-ffprobe', '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swresample', '--enable-pthreads',
                 '--enable-decoder=pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_u8,pcm_s8,pcm_alaw,pcm_mulaw,adpcm_ima_wav,opus,vorbis,mp3,mp3float,aac,aac_latm,flac,alac',
                 '--enable-parser=aac,aac_latm,mpegaudio,opus,vorbis,flac', '--enable-demuxer=wav,ogg,mp3,mov,flac,aac,matroska,aiff,au,caf', '--enable-protocol=file,pipe', '--enable-muxer=wav,null', '--enable-filter=aresample,aformat,anull,atrim,asetpts', '--enable-encoder=pcm_s16le',
                 '--extra-cflags=-mmacosx-version-min=14.0', '--extra-ldflags=-mmacosx-version-min=14.0']
    subprocess.run(configure, cwd=source, check=True)
    subprocess.run(['make', '-j6'], cwd=source, check=True)
    subprocess.run(['make', 'install'], cwd=source, check=True)
    shutil.copyfile(args.source, output / 'FFmpeg-n8.0.1-source.tar.gz')
    (output / 'build-manifest.json').write_text(json.dumps({'sourceUrl': SOURCE_URL, 'sourceSha256': SOURCE_SHA256, 'configure': configure, 'version': '8.0.1', 'sourceChanges': {'VERSION': '8.0.1'}, 'minimumMacOS': '14.0', 'externalCodecLibraries': False}, indent=2) + '\n')

if __name__ == '__main__':
    main()
