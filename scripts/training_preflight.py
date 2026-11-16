"""Read-only training capacity snapshot. Does not download, train or reserve GPUs.

Example: python scripts/training_preflight.py --disk-path /local_nvme_data/zizhuo
PyTorch is imported in a child process with GPUs hidden; GPU capacity comes only
from nvidia-smi. Reported free memory is a snapshot, not authorization to use it.
"""
import argparse
import csv
import datetime
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


PACKAGES = (
    "torch", "transformers", "trl", "peft", "accelerate", "deepspeed",
    "vllm", "bitsandbytes", "datasets", "safetensors",
)
GPU_FIELDS = (
    "index", "name", "memory.total", "memory.used", "memory.free",
    "utilization.gpu", "driver_version",
)


def package_versions():
    result = {}
    for package in PACKAGES:
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            result[package] = None
    return result


def torch_build():
    # Do not call torch.cuda.is_available(), initialize CUDA or allocate tensors.
    child_env = os.environ.copy()
    child_env["CUDA_VISIBLE_DEVICES"] = ""
    code = (
        "import json, torch; "
        "print(json.dumps({'version':str(torch.__version__),"
        "'cuda_build':torch.version.cuda,'gpu_devices_hidden':True}))"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-B", "-c", code], env=child_env,
            capture_output=True, text=True, timeout=25, check=False,
        )
        if result.returncode:
            return {"available": False, "error": "torch_import_failed", "returncode": result.returncode}
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        return {"available": True, **payload}
    except subprocess.TimeoutExpired:
        return {"available": False, "error": "torch_import_timeout"}
    except (OSError, ValueError, IndexError):
        return {"available": False, "error": "torch_probe_failed"}


def number_or_none(value):
    try:
        return int(value.strip())
    except (TypeError, ValueError):
        return None


def parse_gpus(output):
    devices = []
    for fields in csv.reader(io.StringIO(output)):
        if not fields:
            continue
        if len(fields) != len(GPU_FIELDS):
            raise ValueError("invalid_gpu_response")
        row = dict(zip(GPU_FIELDS, (field.strip() for field in fields)))
        devices.append({
            "index": number_or_none(row["index"]),
            "name": row["name"],
            "memory_total_mib": number_or_none(row["memory.total"]),
            "memory_used_mib": number_or_none(row["memory.used"]),
            "memory_free_mib": number_or_none(row["memory.free"]),
            "utilization_percent": number_or_none(row["utilization.gpu"]),
            "driver_version": row["driver_version"],
        })
    return devices


def gpu_snapshot():
    executable = shutil.which("nvidia-smi")
    if not executable:
        return {"available": False, "error": "nvidia_smi_not_found", "devices": []}
    try:
        result = subprocess.run(
            [executable, "--query-gpu=" + ",".join(GPU_FIELDS), "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode:
            return {"available": False, "error": "nvidia_smi_failed", "returncode": result.returncode, "devices": []}
        return {"available": True, "devices": parse_gpus(result.stdout)}
    except subprocess.TimeoutExpired:
        return {"available": False, "error": "nvidia_smi_timeout", "devices": []}
    except (OSError, ValueError):
        return {"available": False, "error": "gpu_probe_failed", "devices": []}


def disk_snapshot(disk_path):
    location = Path(disk_path).expanduser().resolve()
    try:
        usage = shutil.disk_usage(location)
        return {"path": str(location), "total_bytes": usage.total,
                "used_bytes": usage.used, "free_bytes": usage.free}
    except OSError:
        return {"path": str(location), "error": "disk_path_unavailable"}


def report(disk_paths):
    return {
        "schema_version": 1,
        "captured_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "read_only": True,
        "gpu_allocation_performed": False,
        "python": {"version": platform.python_version(), "executable": sys.executable},
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "packages": package_versions(),
        "torch": torch_build(),
        "gpus": gpu_snapshot(),
        "disks": [disk_snapshot(path) for path in disk_paths],
        "notes": [
            "No training, model download, GPU reservation or allocation was performed.",
            "Free GPU memory is a point-in-time capacity snapshot, not a reservation or permission.",
            "CUDA build version describes this PyTorch installation; CUDA runtime compatibility was not tested.",
            "Model dimensions, optimizer states, rollout replicas and sequence lengths must be known before sizing RL training.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disk-path", action="append", help="Existing path to inspect; repeat for multiple disks.")
    args = parser.parse_args()
    print(json.dumps(report(args.disk_path or [str(Path.cwd())]), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
