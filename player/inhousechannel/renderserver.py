"""Local HTTP server on 127.0.0.1 that Chrome renders from.

Serves the active layout directory (step 2: synced from the content server) and, until a
layout exists, the built-in slate shipped with the package. Also serves /status.json so the
page can show player identity. Pure stdlib; runs in a daemon thread.
"""
import json
import os
import socket
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
SLATE_DIR = os.path.join(PKG_DIR, "assets", "slate")


class RenderServer:
    def __init__(self, port: int, status_fn: Callable[[], Dict], root: str = None):
        self.port = port
        self.status_fn = status_fn
        self.root = root or SLATE_DIR
        self._httpd = None
        self._thread = None

    def set_root(self, root: str) -> None:
        self.root = root

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d/" % self.port

    def start(self) -> None:
        server = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=server.root, **kw)

            def do_GET(self):
                if self.path.split("?")[0] == "/status.json":
                    body = json.dumps(server.status_fn()).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                # directory may have been swapped since construction
                self.directory = server.root
                super().do_GET()

            def end_headers(self):
                self.send_header("Cache-Control", "no-store")
                super().end_headers()

            def log_message(self, fmt, *args):  # quiet; journald gets the daemon's own logs
                pass

        self._httpd = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="render-http", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()


def hostname() -> str:
    return socket.gethostname()
