#!/usr/bin/env python3
"""Loopback-only server for a UE5 HTML5 export and Discord SDK mock preview."""

import argparse
import functools
import http.server
import json
from pathlib import Path
import secrets
import socketserver
import sys
import threading
from urllib.parse import urlencode, urlsplit
import webbrowser


class PreviewServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class CertificationHandler(http.server.SimpleHTTPRequestHandler):
    """Static export handler with one token-protected, loopback-only report endpoint."""

    maximum_report_bytes = 1024 * 1024

    def reject(self, status, message):
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path != "/__ue5html5_certification__":
            self.reject(404, "Not found")
            return
        supplied = self.headers.get("X-UE5HTML5-Certification-Token", "")
        if not supplied or not secrets.compare_digest(supplied, self.server.certification_token):
            self.reject(403, "Invalid certification token")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.reject(400, "Invalid Content-Length")
            return
        if length <= 0 or length > self.maximum_report_bytes:
            self.reject(413, "Certification report size is invalid")
            return
        try:
            report = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.reject(400, "Certification report must be UTF-8 JSON")
            return
        if not isinstance(report, dict) or report.get("schema") != "ue5-html5-browser-certification/v2":
            self.reject(422, "Unsupported certification report schema")
            return
        if report.get("status") not in ("passed", "failed"):
            self.reject(422, "Certification report status must be passed or failed")
            return

        self.server.certification_report = report
        self.send_response(204)
        self.end_headers()
        threading.Thread(target=self.server.shutdown, daemon=True).start()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--discord-preview", action="store_true", help="enable the local-only Discord SDK mock")
    mode.add_argument("--certify", action="store_true", help="prove cold/warm asset delivery and first-person target gameplay")
    parser.add_argument("--port", type=int, default=8000, help="loopback port; falls back to a free port when occupied")
    parser.add_argument("--no-browser", action="store_true", help="serve without opening the default browser")
    parser.add_argument("--certification-output", default="browser-certification.json", help="JSON report path for --certify")
    parser.add_argument("--certification-timeout", type=float, default=90, help="seconds to wait for --certify")
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
        print("UE5 HTML5 preview and browser certification launcher check passed.")
        return 0
    if not (root / "index.html").is_file():
        raise SystemExit("Preview failed: index.html is missing beside serve.py.")
    if not 0 <= options.port <= 65535:
        raise SystemExit("Preview failed: --port must be between 0 and 65535.")
    if not 5 <= options.certification_timeout <= 600:
        raise SystemExit("Preview failed: --certification-timeout must be between 5 and 600 seconds.")

    handler_type = CertificationHandler if options.certify else http.server.SimpleHTTPRequestHandler
    handler = functools.partial(handler_type, directory=root)
    with create_server(handler, options.port) as server:
        port = server.server_address[1]
        timer = None
        if options.certify:
            server.certification_token = secrets.token_hex(24)
            server.certification_report = None
            query = urlencode({
                "ue5_certify": "1",
                "ue5_certify_token": server.certification_token,
            })
            suffix = f"/?{query}"
            label = "UE5 browser certification"
            timer = threading.Timer(options.certification_timeout, server.shutdown)
            timer.daemon = True
            timer.start()
        else:
            suffix = "/?ue5_discord_preview=1" if options.discord_preview else "/"
            label = "Discord Blueprint mock preview" if options.discord_preview else "HTML5 preview"
        url = f"http://127.0.0.1:{port}{suffix}"
        print(f"Serving {label} at {url} (Ctrl+C to stop)")
        if not options.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nPreview stopped.")
        finally:
            if timer:
                timer.cancel()

        if options.certify:
            report = server.certification_report
            if report is None:
                raise SystemExit(f"Browser certification timed out after {options.certification_timeout:g} seconds.")
            output = Path(options.certification_output).expanduser()
            if not output.is_absolute():
                output = root / output
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Browser certification {report['status']}: {output}")
            return 0 if report["status"] == "passed" else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
