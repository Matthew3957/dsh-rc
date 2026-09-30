#!/usr/bin/env python3
"""Static file server for dsh-rc. Bound to loopback; Tailscale Serve mounts it at /m
on the same origin as dsh web, which is what dsh's same-origin trust check requires."""
import http.server, os, sys
from functools import partial

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PORT = int(os.environ.get("DSH_MOBILE_PORT", "3081"))

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".js": "text/javascript",
                      ".svg": "image/svg+xml"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), partial(H, directory=ROOT))
    print(f"dsh-rc on http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
