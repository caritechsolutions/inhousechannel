"""Local HTTP server on 127.0.0.1 that Chrome renders from. Pure stdlib, daemon thread.

Routes:
  /                 shell page: full-screen iframe that polls /current.json and swaps its src,
                    so a layout change never restarts Chrome (and so never breaks the TS)
  /current.json     {"url": "/slate/" | "/layouts/<id>/", "layout_id": ...}
  /status.json      player status (shown on the slate)
  /slate/...        built-in slate shipped with the package
  /layouts/...      synced layouts from the cache (each dir is self-contained)
"""
import json
import os
import posixpath
import socket
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict, Optional
from urllib.parse import unquote

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
SLATE_DIR = os.path.join(PKG_DIR, "assets", "slate")

SHELL_HTML = b"""<!doctype html><html><head><meta charset="utf-8"><title>inhousechannel</title>
<style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#000}
iframe{position:absolute;inset:0;width:100vw;height:100vh;border:0}</style></head>
<body><iframe id="f" src="/slate/"></iframe>
<script>
var cur="/slate/";
function poll(){fetch("/current.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(c){
  if(c.url&&c.url!==cur){cur=c.url;document.getElementById("f").src=c.url+"?t="+Date.now();}
}).catch(function(){}).then(function(){setTimeout(poll,2000)});}
poll();
</script></body></html>"""


class RenderServer:
    def __init__(self, port: int, status_fn: Callable[[], Dict], layouts_dir: Optional[str] = None):
        self.port = port
        self.status_fn = status_fn
        self.layouts_dir = layouts_dir
        self.current_url = "/slate/"
        self.current_layout_id = None
        self._httpd = None
        self._thread = None

    def set_current(self, layout_id, layout_dir: Optional[str]) -> bool:
        """Point the shell at a layout dir (or the slate when None). Returns True on change."""
        url = "/layouts/%s/" % layout_id if layout_dir else "/slate/"
        changed = url != self.current_url
        self.current_url, self.current_layout_id = url, (layout_id if layout_dir else None)
        return changed

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d/" % self.port

    def start(self) -> None:
        server = self

        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self):
                path = unquote(self.path.split("?")[0])
                if path == "/" or path == "/index.html":
                    return self._send(200, "text/html", SHELL_HTML)
                if path == "/current.json":
                    return self._send(200, "application/json", json.dumps(
                        {"url": server.current_url, "layout_id": server.current_layout_id}).encode())
                if path == "/status.json":
                    return self._send(200, "application/json", json.dumps(server.status_fn()).encode())
                if path.startswith("/slate/"):
                    self.directory = SLATE_DIR
                    self.path = path[len("/slate"):] or "/"
                elif path.startswith("/layouts/") and server.layouts_dir:
                    self.directory = server.layouts_dir
                    self.path = path[len("/layouts"):] or "/"
                else:
                    return self._send(404, "text/plain", b"not found")
                super().do_GET()

            def translate_path(self, path):
                # SimpleHTTPRequestHandler resolves against self.directory; keep it inside it
                path = posixpath.normpath(unquote(path.split("?")[0]))
                parts = [p for p in path.split("/") if p and p not in (".", "..")]
                return os.path.join(self.directory, *parts)

            def _send(self, code, ctype, body):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def end_headers(self):
                self.send_header("Cache-Control", "no-store")
                super().end_headers()

            def log_message(self, fmt, *args):
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
