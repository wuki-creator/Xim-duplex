"""Exercise the internal HTTP contract, or validate a live pinned model worker.

Without --live this uses a stub predictor solely to test request validation,
overload and error handling. It is not evidence of model accuracy/inference.
With --live, --pcm accepts a real headerless 16 kHz mono PCM16 recording.
"""
import argparse
import http.client
import json
import math
from pathlib import Path
import threading
import time
import urllib.request

from turn_worker import TurnServer, MODEL_NAME


class StubPredictor:
    fail = False

    def predict(self, _raw):
        if self.fail:
            raise RuntimeError("stub_failure")
        return {"complete": True, "probability": 0.75}


def request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def contract_checks():
    stub = StubPredictor()
    server = TurnServer(("127.0.0.1", 0), stub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    pcm = {"Content-Type": "application/octet-stream"}
    try:
        assert request(port, "GET", "/health")[1]["ready"] is True
        status, body = request(port, "POST", "/predict", bytes(16000), pcm)
        assert status == 200 and body["complete"] is True and body["probability"] == 0.75
        assert request(port, "POST", "/predict", b"x", pcm)[0] == 400
        assert request(port, "POST", "/predict", b"", pcm)[0] == 400
        assert request(port, "POST", "/predict", b"x" * 960002, pcm)[0] == 400
        assert request(port, "POST", "/predict", b"RIFF", pcm)[0] == 415
        assert request(port, "POST", "/predict", bytes(16000), {"Content-Type": "application/json"})[0] == 415
        assert request(port, "POST", "/predict", bytes(16000), {**pcm, "Origin": "https://example.com"})[0] == 403
        assert request(port, "POST", "/missing", bytes(16000), pcm)[0] == 404
        server.lock.acquire()
        try:
            assert request(port, "POST", "/predict", bytes(16000), pcm)[0] == 429
        finally:
            server.lock.release()
        stub.fail = True
        assert request(port, "POST", "/predict", bytes(16000), pcm)[0] == 503
        stub.fail = False
        assert request(port, "POST", "/predict", bytes(16000), pcm)[0] == 200
        print(json.dumps({"http_contract_checks": "passed", "real_model_tested": False}))
    finally:
        server.shutdown()
        server.server_close()


def live_checks(base_url, pcm_file):
    with urllib.request.urlopen(base_url + "/health", timeout=5) as response:
        health = json.load(response)
    assert health["ready"] is True and health["model"] == MODEL_NAME
    pcm = pcm_file.read_bytes() if pcm_file else bytes(32000)
    records = []
    for _ in range(5):
        request_body = urllib.request.Request(base_url + "/predict", data=pcm,
                                             headers={"Content-Type": "application/octet-stream"})
        started = time.perf_counter()
        with urllib.request.urlopen(request_body, timeout=8) as response:
            result = json.load(response)
        assert isinstance(result["complete"], bool)
        assert math.isfinite(result["probability"]) and 0 <= result["probability"] <= 1
        records.append({**result, "round_trip_ms": round((time.perf_counter() - started) * 1000, 2)})
    print(json.dumps({"live_validation": "passed", "input": "provided_recording" if pcm_file else "silence_only",
                      "accuracy_measured": False, "health": health, "samples": records}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", help="Loopback worker URL, e.g. http://127.0.0.1:18796")
    parser.add_argument("--pcm", type=Path, help="16 kHz mono headerless PCM16 LE recording")
    args = parser.parse_args()
    if args.live:
        live_checks(args.live.rstrip("/"), args.pcm)
    else:
        contract_checks()
