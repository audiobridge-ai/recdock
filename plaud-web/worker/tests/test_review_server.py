from http.client import HTTPResponse
from io import BytesIO
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest

from recdock_audio.review_server import byte_range, handler_for


class ReviewServerTests(unittest.TestCase):
    def test_ranges_for_audio_seeking_and_suffix(self):
        self.assertEqual(byte_range("bytes=2-4", 10), (2, 4, 206))
        self.assertEqual(byte_range("bytes=8-", 10), (8, 9, 206))
        self.assertEqual(byte_range("bytes=-3", 10), (7, 9, 206))
        for value in ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5", "bytes=-"]:
            with self.assertRaises(ValueError):
                byte_range(value, 10)

    def test_http_handler_serves_exact_bytes_and_rejects_foreign_requests(self):
        # Exercise real HTTP parsing and response streaming without an OS listening socket.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "audio.mp3").write_bytes(b"0123456789")
            port = 8766
            class MemorySocket:
                def __init__(self, data):
                    self.input, self.output = BytesIO(data), BytesIO()
                def makefile(self, *_args):
                    return self.input
                def sendall(self, data):
                    self.output.write(data)
            def get(path, headers=None):
                values = {"Host": f"127.0.0.1:{port}", **(headers or {})}
                request = (f"GET {path} HTTP/1.0\r\n" + "".join(f"{k}: {v}\r\n" for k, v in values.items()) + "\r\n").encode()
                connection = MemorySocket(request)
                handler_for(root)(connection, ("127.0.0.1", 12345), SimpleNamespace(server_address=("127.0.0.1", port)))
                response = HTTPResponse(MemorySocket(connection.output.getvalue()))
                response.begin()
                return response.status, dict(response.getheaders()), response.read()
            status, headers, body = get("/audio.mp3", {"Range": "bytes=2-4"})
            self.assertEqual((status, body), (206, b"234"))
            self.assertEqual(headers["Content-Range"], "bytes 2-4/10")
            self.assertEqual(get("/audio.mp3", {"Host": "evil.example"})[0], 403)
            self.assertEqual(get("/audio.mp3", {"Origin": "https://evil.example"})[0], 403)
            self.assertEqual(get("/audio.mp3", {"Sec-Fetch-Site": "cross-site"})[0], 403)
            self.assertEqual(get("/%2e%2e/outside")[0], 404)
            self.assertEqual(get("/audio.mp3", {"Range": "bytes=99-"})[0], 416)
