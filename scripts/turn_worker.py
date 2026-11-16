"""Loopback-only Smart Turn v3.2 endpoint detector; never downloads model files.

POST /predict: headerless little-endian PCM16, mono, 16 kHz (up to 30 s).
The upstream feature pipeline keeps the last 8 s and left-pads shorter turns.
This predicts acoustic turn completion, not ASR, user intent, or a world model.
Feature preparation follows pipecat-ai/smart-turn (BSD-2-Clause); see
data/smart-turn/LICENSE.smart-turn installed alongside the pinned checkpoint.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from install_turn_model import MODEL_FILE, REVISION, SHA256

MODEL_NAME = "smart-turn-v3.2-cpu"
MAX_BYTES = 30 * 16000 * 2


class TurnPredictor:
    def __init__(self, model_path, threads=2):
        # Set before importing Transformers so the worker cannot fetch assets.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import numpy as np
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor
        if not model_path.is_file():
            raise ValueError("checkpoint_missing_run_install_turn_model")
        if hashlib.sha256(model_path.read_bytes()).hexdigest() != SHA256:
            raise ValueError("checkpoint_checksum_mismatch")
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = threads
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        self.extractor = WhisperFeatureExtractor(chunk_length=8)
        self.np = np
        self.ort = ort
        actual_inputs = self.session.get_inputs()
        if len(actual_inputs) != 1 or actual_inputs[0].name != "input_features":
            raise ValueError("unexpected_checkpoint_inputs")

    def predict(self, raw):
        np = self.np
        waveform = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        waveform = waveform[-128000:]
        if len(waveform) < 128000:
            waveform = np.pad(waveform, (128000 - len(waveform), 0))
        features = self.extractor(waveform, sampling_rate=16000, return_tensors="np",
                                  padding="max_length", max_length=128000,
                                  truncation=True, do_normalize=True).input_features.astype(np.float32)
        options = self.ort.RunOptions()
        deadline = threading.Timer(3, lambda: setattr(options, "terminate", True))
        deadline.daemon = True
        deadline.start()
        try:
            value = self.session.run(None, {"input_features": features}, run_options=options)[0]
        finally:
            deadline.cancel()
        value = np.asarray(value)
        if value.size != 1:
            raise ValueError("invalid_model_probability_shape")
        probability = float(value.reshape(-1)[0])
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError("invalid_model_probability")
        return {"complete": probability > 0.5, "probability": probability}


class TurnServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, predictor):
        super().__init__(address, TurnHandler)
        self.predictor = predictor
        self.lock = threading.Lock()


class TurnHandler(BaseHTTPRequestHandler):
    server_version = "XimTurn/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health":
            return self.send_json(404, {"error": "not_found"})
        return self.send_json(200, {"ready": True, "model": MODEL_NAME, "revision": REVISION,
                                    "sha256": SHA256, "sample_rate": 16000,
                                    "maximum_context_seconds": 8, "fine_tuned": False})

    def do_POST(self):
        if self.path != "/predict":
            return self.send_json(404, {"error": "not_found"})
        # No browser origins: this is an internal service, accessed by the Node backend.
        if self.headers.get("Origin"):
            return self.send_json(403, {"error": "origin_not_allowed"})
        if self.headers.get("Transfer-Encoding"):
            return self.send_json(400, {"error": "chunked_body_not_supported"})
        if self.headers.get_content_type() not in ("application/octet-stream", "audio/pcm"):
            return self.send_json(415, {"error": "expected_pcm16"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "invalid_length"})
        if length <= 0 or length % 2 or length > MAX_BYTES:
            return self.send_json(400, {"error": "invalid_pcm_length"})
        if not self.server.lock.acquire(blocking=False):
            return self.send_json(429, {"error": "busy"})
        try:
            started = time.perf_counter()
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.send_json(400, {"error": "incomplete_pcm"})
            if raw[:4] in (b"RIFF", b"OggS") or raw[:4] == bytes.fromhex("1a45dfa3"):
                return self.send_json(415, {"error": "expected_headerless_pcm"})
            result = self.server.predictor.predict(raw)
            result.update({"model": MODEL_NAME, "elapsed_ms": round((time.perf_counter() - started) * 1000, 2)})
            return self.send_json(200, result)
        except socket.timeout:
            return self.send_json(408, {"error": "body_timeout"})
        except Exception:
            return self.send_json(503, {"error": "turn_prediction_failed"})
        finally:
            self.server.lock.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "smart-turn" / MODEL_FILE)
    parser.add_argument("--port", type=int, default=18796)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.threads <= 8:
        parser.error("invalid port or threads")
    predictor = TurnPredictor(args.model, args.threads)
    # A warm-up validates both output and preprocessing before health becomes ready.
    predictor.predict(bytes(32000))
    server = TurnServer(("127.0.0.1", args.port), predictor)
    print(json.dumps({"ready": True, "model": MODEL_NAME, "port": args.port}), flush=True)
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
