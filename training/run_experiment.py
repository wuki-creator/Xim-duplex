"""Run the predeclared xim-chat-v1 experiment after verifying local weights.

No downloads, background scheduling, deployment, cloud APIs or shell commands.
The foreground process waits for verified files and a free allowed GPU, then
runs the fixed SFT/GRPO/evaluation sequence in its own Python environment.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from train_multitask import atomic_json, file_hash, read_rows

WEIGHTS = {
    "model-00001-of-00005.safetensors": "31d6a825ae35f11fb85b195b4c42c146c051e446433125a215336abdf95cbf5f",
    "model-00002-of-00005.safetensors": "5991236cea6fe21f3d43cab0f0e84448734fbbe0789816202989f2ddc9d18282",
    "model-00003-of-00005.safetensors": "c5185c4794be2d8a9784d5753c9922db38df478ce11f9ed0b415b7304d896836",
    "model-00004-of-00005.safetensors": "b5ee7de71fbf17db3d5704e0c8f2bc7d005ca9e1d7ca2aeb19827b0cfcaa917a",
    "model-00005-of-00005.safetensors": "20c2d6366ab85c90786ccdd829cd2b9e7d30ef3b2ebbb998280e7e4014b542ff",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--run-name", default="xim-chat-v1-r1")
    parser.add_argument("--allowed-gpus", default="6,1")
    parser.add_argument("--wait-seconds", type=int, default=14400)
    args = parser.parse_args()
    if not args.run_name.replace("-", "").isalnum() or not 1 <= args.wait_seconds <= 14400:
        parser.error("A simple run name and a wait bound up to four hours are required")
    allowed = args.allowed_gpus.split(",")
    if not allowed or any(not item.isdigit() for item in allowed):
        parser.error("Allowed GPUs must be explicit numeric device indices")
    root = args.root.resolve()
    model = root / "qwen3-8b"
    inputs = {}
    for name, split, count, require_case in (
        ("sft-train.jsonl", "train", 544, False),
        ("multitask-synthetic-v1/train.jsonl", "train", 480, True),
        ("multitask-synthetic-v1/holdout.jsonl", "holdout", 100, True),
        ("public-sft-validation.jsonl", "validation", 16, False),
    ):
        target = root / "data" / name
        if len(read_rows(target, split, require_case=require_case)) != count:
            raise ValueError("Input row count differs from the predeclared plan: " + name)
        inputs[name] = {"rows": count, "sha256": file_hash(target)}
    output = root / "outputs" / args.run_name
    output.mkdir(parents=True, exist_ok=False)
    state = {"model_name": "xim-chat-v1", "status": "waiting_for_weights", "pilot_only": True,
             "inputs": inputs,
             "plan": {"sft_steps": 136, "grpo_steps": 120, "stage_timeout_seconds": 3600, "task_holdout_rows": 100,
                      "public_validation_rows": 16, "selection_uses_holdout": False},
             "sources": {name: file_hash(Path(__file__).with_name(name)) for name in (
                 "run_experiment.py", "train_multitask.py", "multitask_rewards.py",
                 "evaluate_multitask.py", "evaluate_dialogue.py")},
             "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "stages": []}

    def save():
        atomic_json(output / "experiment.json", state)

    save()
    deadline = time.monotonic() + args.wait_seconds
    verified = set()
    try:
        while len(verified) < len(WEIGHTS):
            for name, checksum in WEIGHTS.items():
                target = model / name
                if name not in verified and target.is_file():
                    if file_hash(target) != checksum:
                        raise ValueError("Fixed upstream weight checksum mismatch: " + name)
                    verified.add(name)
                    state["verified_weights"] = sorted(verified)
                    save()
                    print("verified", name, flush=True)
            if len(verified) < len(WEIGHTS):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Weights have not arrived within the bounded wait")
                time.sleep(30)
        state["status"] = "waiting_for_gpu"
        save()
        while True:
            probe = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.free,utilization.gpu", "--format=csv,noheader,nounits"],
                                   capture_output=True, text=True, check=True, timeout=15)
            devices = {line.split(",")[0].strip(): [int(value.strip()) for value in line.split(",")[1:]]
                       for line in probe.stdout.strip().splitlines()}
            selected = next((gpu for gpu in allowed if gpu in devices and devices[gpu][0] >= 65000 and devices[gpu][1] == 0), None)
            if selected is not None:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("No allowed GPU had enough free memory")
            time.sleep(30)
        state.update(status="running", selected_gpu=selected, gpu_snapshot=devices)
        save()
        env = os.environ.copy()
        env["CUDA_VISIBLE_DEVICES"] = selected
        for key, value in {"TMPDIR": "tmp", "HF_HOME": "cache", "XDG_CACHE_HOME": "cache",
                           "TORCH_HOME": "cache/torch", "TRITON_CACHE_DIR": "cache/triton", "CUDA_CACHE_PATH": "cache/cuda"}.items():
            location = root / value
            location.mkdir(parents=True, exist_ok=True)
            env[key] = str(location)
        common = ["--model-dir", str(model)]
        sft, grpo = output / "sft", output / "grpo"
        stages = [
            ("sft", "train_multitask.py", ["--stage", "sft", *common, "--data", str(root / "data/sft-train.jsonl"), "--output", str(sft), "--max-steps", "136"]),
            ("grpo", "train_multitask.py", ["--stage", "grpo", *common, "--data", str(root / "data/multitask-synthetic-v1/train.jsonl"), "--sft-adapter", str(sft), "--output", str(grpo), "--max-steps", "120"]),
        ]
        for label, adapter in (("sft", sft), ("grpo", grpo)):
            stages.extend([
                (label + "-tasks", "evaluate_multitask.py", [*common, "--adapter", str(adapter), "--holdout", str(root / "data/multitask-synthetic-v1/holdout.jsonl"), "--output", str(output / (label + "-tasks.json"))]),
                (label + "-dialogue", "evaluate_dialogue.py", [*common, "--adapter", str(adapter), "--validation", str(root / "data/public-sft-validation.jsonl"), "--include-examples", "--output", str(output / (label + "-dialogue.json"))]),
            ])
        for name, script, arguments in stages:
            if any(file_hash(Path(__file__).with_name(source)) != checksum for source, checksum in state["sources"].items()):
                raise ValueError("Experiment source changed after the plan was recorded")
            if any(file_hash(root / "data" / source) != record["sha256"] for source, record in inputs.items()):
                raise ValueError("Experiment data changed after the plan was recorded")
            state["active_stage"] = name
            save()
            started = time.monotonic()
            command = [sys.executable, "-u", str(Path(__file__).with_name(script)), *arguments]
            with (output / (name + ".log")).open("w", encoding="utf-8") as log:
                result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, check=False, timeout=3600)
            state["stages"].append({"stage": name, "returncode": result.returncode, "seconds": time.monotonic() - started})
            save()
            if result.returncode != 0:
                raise RuntimeError("Stage failed: " + name)
            print("completed", name, flush=True)
        state.update(status="completed", active_stage=None)
    except BaseException as error:
        state.update(status="failed", error_type=type(error).__name__, error=str(error))
        raise
    finally:
        state["updated_at_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()


if __name__ == "__main__":
    main()
