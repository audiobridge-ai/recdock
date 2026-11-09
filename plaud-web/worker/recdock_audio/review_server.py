"""Read-only loopback viewer with byte ranges for long-recording seeking."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


def byte_range(value: str | None, size: int) -> tuple[int, int, int]:
    if value is None:
        return 0, size - 1, 200
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("INVALID_RANGE")
    left, right = match.groups()
    if left:
        start, end = int(left), min(int(right) if right else size - 1, size - 1)
    else:
        if int(right) <= 0:
            raise ValueError("INVALID_RANGE")
        start, end = max(0, size - int(right)), size - 1
    if not 0 <= start <= end < size:
        raise ValueError("INVALID_RANGE")
    return start, end, 206


def handler_for(root: Path):
    root = root.resolve()

    class ReviewHandler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.respond(False)

        def do_GET(self):
            self.respond(True)

        def respond(self, body: bool):
            port = self.server.server_address[1]
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            if self.headers.get("Host", "") not in hosts or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403)
                return
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + h for h in hosts}:
                self.send_error(403)
                return
            path = unquote(urlsplit(self.path).path)
            target = (root / (path.lstrip("/") or "index.html")).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                self.send_error(404)
                return
            size = target.stat().st_size
            try:
                start, end, status = byte_range(self.headers.get("Range"), size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(status)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if body:
                try:
                    with target.open("rb") as stream:
                        stream.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            data = stream.read(min(65536, remaining))
                            if not data:
                                break
                            self.wfile.write(data)
                            remaining -= len(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def log_message(self, format, *args):
            pass

    return ReviewHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--port", default=8766, type=int)
    args = parser.parse_args()
    if not (args.root / "index.html").is_file():
        parser.error("review bundle index.html is missing")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(args.root))
    print(f"RecDock review: http://127.0.0.1:{server.server_address[1]}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
