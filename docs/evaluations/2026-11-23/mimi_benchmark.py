"""Deterministic Mimi streaming-encoder microbenchmark; no user audio is used."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import sys
import time
from datetime import datetime, timezone

import numpy as np
import rustymimi

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("/local_nvme_data/zizhuo/xim_target_eval")
WEIGHTS = ROOT / "mimi-tokenizer.safetensors"
OUTPUT = ROOT / "mimi.json"
SAMPLE_RATE = 24_000
FRAME_SAMPLES = 1_920
FRAMES = 48
RUNS = 10

sha256 = hashlib.sha256()
with WEIGHTS.open("rb") as handle:
    for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
        sha256.update(block)

tokenizer = rustymimi.Tokenizer(str(WEIGHTS), num_codebooks=8)
t = np.arange(FRAME_SAMPLES * FRAMES, dtype=np.float32) / SAMPLE_RATE
audio = (0.20 * np.sin(2 * np.pi * 220 * t) +
         0.10 * np.sin(2 * np.pi * 440 * t) +
         0.05 * np.sin(2 * np.pi * 880 * t)).astype(np.float32)


def encode_all():
    tokenizer.reset()
    frame_times_ms = []
    code_shape = None
    for index in range(FRAMES):
        chunk = audio[index * FRAME_SAMPLES:(index + 1) * FRAME_SAMPLES]
        batch = np.ascontiguousarray(chunk[None, None, :])
        started = time.perf_counter()
        codes = tokenizer.encode_step(batch)
        frame_times_ms.append((time.perf_counter() - started) * 1000.0)
        code_shape = list(codes.shape)
    return frame_times_ms, code_shape


warmup_times, warmup_shape = encode_all()
runs = []
for run_index in range(RUNS):
    started = time.perf_counter()
    frame_times, code_shape = encode_all()
    total_ms = (time.perf_counter() - started) * 1000.0
    runs.append({
        "run": run_index + 1,
        "total_ms": total_ms,
        "frame_compute_ms": frame_times,
        "sum_frame_compute_ms": sum(frame_times),
        "codes_shape": code_shape,
    })

totals = [run["total_ms"] for run in runs]
result = {
    "schema": "xim.component-benchmark.v1",
    "component": "Mimi streaming audio encoder only",
    "status": "MEASURED_COMPONENT_NOT_INTEGRATED",
    "timestamp_utc": datetime.now(timezone.utc).isoformat(),
    "host": socket.gethostname(),
    "platform": platform.platform(),
    "python": platform.python_version(),
    "packages": {
        "rustymimi": importlib.metadata.version("rustymimi"),
        "numpy": importlib.metadata.version("numpy"),
    },
    "weights": {
        "file": WEIGHTS.name,
        "bytes": WEIGHTS.stat().st_size,
        "sha256": sha256.hexdigest(),
        "source": "https://huggingface.co/kyutai/moshiko-pytorch-bf16/resolve/main/tokenizer-e351c8d8-checkpoint125.safetensors",
    },
    "method": {
        "input": "deterministic synthetic sine mixture; no private or user audio",
        "sample_rate_hz": SAMPLE_RATE,
        "channels": 1,
        "dtype": "float32",
        "num_codebooks": 8,
        "frame_samples": FRAME_SAMPLES,
        "frame_duration_ms": 80,
        "frames_per_run": FRAMES,
        "audio_duration_ms_per_run": FRAMES * 80,
        "warmup_runs_excluded": 1,
        "measured_runs": RUNS,
        "timing": "wall-clock around encode_step; model load and weight hashing excluded",
        "scope": "encoder latency only; no semantic, reconstruction-quality, LLM, TTS, or LiveBridge integration claim",
    },
    "warmup": {"sum_frame_compute_ms": sum(warmup_times), "codes_shape": warmup_shape},
    "runs": runs,
    "summary_ms": {
        "n": RUNS,
        "mean_total": statistics.fmean(totals),
        "p50_total_nearest_rank": sorted(totals)[max(0, int(np.ceil(0.50 * len(totals))) - 1)],
        "p95_total_nearest_rank": sorted(totals)[max(0, int(np.ceil(0.95 * len(totals))) - 1)],
        "min_total": min(totals),
        "max_total": max(totals),
    },
}
OUTPUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({"output": str(OUTPUT), "summary_ms": result["summary_ms"],
                  "codes_shape": runs[-1]["codes_shape"], "packages": result["packages"]}, indent=2))
