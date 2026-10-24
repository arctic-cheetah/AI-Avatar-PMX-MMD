"""Serve the renderer and the local PMX pack, plus optional local voice input.

The model folder stays outside git. This server only exposes it on localhost.
With --stt it also answers POST /stt: a recording from the renderer page goes
to a local Whisper worker and only the transcript comes back.
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "renderer"
sys.path.insert(0, str(ROOT))
from controller.stt import SttWorker, UploadError, check_upload  # noqa: E402


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Yidhari renderer.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--stt", action="store_true", help="Enable local voice input (POST /stt).")
    parser.add_argument("--stt-model", default="base.en", choices=["base.en", "small.en"])
    parser.add_argument("--stt-threads", type=int, default=4)
    parser.add_argument("--stt-prompt", default=None,
                        help="Vocabulary hint for Whisper (default mentions Yidhari); \"\" disables it.")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.origin = f"http://{args.host}:{args.port}"
    server.stt = None
    if args.stt:
        server.stt = SttWorker(args.stt_model, args.stt_threads, prompt=args.stt_prompt)
        ready = server.stt.start()
        print(f"STT worker ready: {ready.get('model')} on CPU, loaded in {ready.get('loadSeconds')} s")
    print(f"Yidhari renderer: http://{args.host}:{args.port}/renderer/")
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
