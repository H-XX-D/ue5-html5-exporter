#!/usr/bin/env python3
"""Loopback-only server for a UE5 HTML5 export and Discord SDK mock preview."""

import argparse
import functools
import http.server
from pathlib import Path
import socketserver
import sys
import webbrowser


class PreviewServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--discord-preview", action="store_true", help="enable the local-only Discord SDK mock")
    parser.add_argument("--port", type=int, default=8000, help="loopback port; falls back to a free port when occupied")
    parser.add_argument("--no-browser", action="store_true", help="serve without opening the default browser")
    parser.add_argument("--check", action="store_true", help="validate the preview launcher and exit")
    return parser.parse_args()


def create_server(handler, port):
    try:
        return PreviewServer(("127.0.0.1", port), handler)
    except OSError:
        if port == 0:
            raise
        return PreviewServer(("127.0.0.1", 0), handler)


def main():
    options = arguments()
    root = Path(__file__).resolve().parent
    if options.check:
        print("UE5 HTML5 preview launcher check passed.")
        return 0
    if not (root / "index.html").is_file():
        raise SystemExit("Preview failed: index.html is missing beside serve.py.")
    if not 0 <= options.port <= 65535:
        raise SystemExit("Preview failed: --port must be between 0 and 65535.")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    with create_server(handler, options.port) as server:
        port = server.server_address[1]
        suffix = "/?ue5_discord_preview=1" if options.discord_preview else "/"
        url = f"http://127.0.0.1:{port}{suffix}"
        label = "Discord Blueprint mock preview" if options.discord_preview else "HTML5 preview"
        print(f"Serving {label} at {url} (Ctrl+C to stop)")
        if not options.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nPreview stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
