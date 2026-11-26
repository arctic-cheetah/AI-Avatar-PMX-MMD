"""Serve the renderer and the local PMX pack, plus optional local voice input.

The model folder stays outside git. This server only exposes it on localhost.
With --stt it also answers POST /stt: a recording from the renderer page goes
to a local Whisper worker and only the transcript comes back. With --no-bridge
the printed URL ends in ?bridge=off: a test page that never connects to the
bridge, so the live avatar keeps agent speech (#215).
"""

from __future__ import annotations

import argparse
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "renderer"
sys.path.insert(0, str(ROOT))
from controller.stt import SttWorker, UploadError, check_upload  # noqa: E402
from controller.pose_store import PoseUploadError, check_pose_upload, normal_name, save_pose  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".pmx": "application/octet-stream",
        ".bmp": "image/bmp",
        ".js": "text/javascript",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path.startswith("/poses/"):
            self.upload_pose()
            return
        if self.path != "/stt":
            self.send_json(404, {"error": "Not found."})
            return
        stt = self.server.stt
        if stt is None:
            self.send_json(503, {"error": "Voice input is off; start serve.py with --stt."})
            return
        try:
            length, suffix = check_upload(self.headers, self.server.origin)
        except UploadError as error:
            self.close_connection = True  # the unread body must not be parsed as a request
            self.send_json(error.status, {"error": str(error)})
            return
        audio = self.rfile.read(length)
        try:
            reply = stt.transcribe(audio, suffix)
        except RuntimeError as error:
            self.log_error("STT worker: %s", error)
            self.send_json(503, {"error": "Speech-to-text is unavailable; check the server log."})
            return
        if not reply.get("ok"):
            # Details (paths, decoder errors) stay in the server log.
            self.log_error("STT failed: %s", reply.get("error"))
            self.send_json(422, {"error": "Could not transcribe that recording."})
            return
        self.send_json(200, {key: reply[key] for key in ("text", "audioSeconds", "sttSeconds") if key in reply})


    def upload_pose(self) -> None:
        """POST /poses/<name>[?overwrite=1]: save a Blender pose (#49)."""
        url = urllib.parse.urlsplit(self.path)
        name = normal_name(urllib.parse.unquote(url.path[len("/poses/"):]))  # NFC (#269)
        overwrite = urllib.parse.parse_qs(url.query).get("overwrite") == ["1"]
        try:
            length = check_pose_upload(self.headers, self.server.origin, name)
        except PoseUploadError as error:
            self.close_connection = True  # the unread body must not be parsed as a request
            self.send_json(error.status, {"error": str(error)})
            return
        data = self.rfile.read(length)
        try:
            save_pose(self.server.poses_dir, name, data, overwrite)
        except PoseUploadError as error:
            self.send_json(error.status, {"error": str(error)})
            return
        self.send_json(201, {"name": name})


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Yidhari renderer.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--stt", action="store_true", help="Enable local voice input (POST /stt).")
    parser.add_argument("--stt-model", default="base.en", choices=["base.en", "small.en"])
    parser.add_argument("--stt-threads", type=int, default=4)
    parser.add_argument("--stt-prompt", default=None,
                        help="Vocabulary hint for Whisper (default mentions Yidhari); \"\" disables it.")
    parser.add_argument("--poses-dir", type=Path, default=ROOT / "assets" / "poses",
                        help="Where uploaded Blender poses (VPD) are saved.")
    parser.add_argument("--no-bridge", action="store_true",
                        help="Print a ?bridge=off test-page URL that never connects to the bridge, "
                             "so the live avatar keeps her voice. Use a free --port, such as 8772.")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        sys.exit(f"Port {args.port} is already in use (is the live renderer running?). "
                 f"Pick another with --port, for example --port {args.port + 2}.")
    port = server.server_address[1]
    server.origin = f"http://{args.host}:{port}"
    server.stt = None
    server.poses_dir = args.poses_dir
    if args.stt:
        server.stt = SttWorker(args.stt_model, args.stt_threads, prompt=args.stt_prompt)
        ready = server.stt.start()
        print(f"STT worker ready: {ready.get('model')} on CPU, loaded in {ready.get('loadSeconds')} s")
    query = "?bridge=off" if args.no_bridge else ""
    print(f"Yidhari renderer: {server.origin}/renderer/{query}")
    if args.no_bridge:
        print("Bridge off: this page never connects to the bridge, so the live avatar keeps her voice.")
    print("Model pack is served from the workspace root. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
        if server.stt is not None:
            server.stt.close()


if __name__ == "__main__":
    main()
