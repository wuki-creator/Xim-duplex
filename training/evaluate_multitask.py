"""Offline, paired baseline/adapter evaluation on the same untouched holdout.

Rule-template scores are engineering checks, not human preference or real voice
quality measurements. Missing models or incomplete training fail explicitly.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import time

from train_multitask import (adapter_manifest, atomic_json, checked_model_dir, file_hash,
                            offline_environment, package_versions, read_rows, render_prompt,
                            require_single_gpu)


def summarize(rows):
    count = len(rows)
    return {"examples": count,
            "format_rate": sum(row["format"] for row in rows) / count,
            "legal_rate": sum(row["legal"] for row in rows) / count,
            "correct_rate": sum(row["correct"] for row in rows) / count,
            "complete_correct_rate": sum(row["correct"] and not row["truncated"] for row in rows) / count,
            "mean_reward": sum(row["reward"] for row in rows) / count,
            "truncated_rate": sum(row["truncated"] for row in rows) / count,
            "mean_generation_seconds": sum(row["generation_seconds"] for row in rows) / count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--holdout", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=0, help="0 means all holdout rows")
    parser.add_argument("--max-sequence-length", type=int, default=1024)
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--seed", type=int, default=3407)
    args = parser.parse_args()
    offline_environment()
    if args.limit < 0 or not 128 <= args.max_sequence_length <= 1024 or not 16 <= args.max_new_tokens < args.max_sequence_length:
        parser.error("Invalid evaluation limits")
    model_path = checked_model_dir(args.model_dir)
    adapter_path, training = adapter_manifest(args.adapter)
    if training.get("base_config_sha256") != file_hash(model_path / "config.json"):
        raise ValueError("Adapter and baseline base configurations differ")
    weights = {path.name: file_hash(path) for path in sorted(model_path.glob("*.safetensors"))}
    if training.get("base_weight_sha256") != weights:
        raise ValueError("Adapter and baseline base weights differ")
    holdout = Path(args.holdout).expanduser().resolve()
    rows = read_rows(holdout, "holdout")
    if {row["id"] for row in rows}.intersection(training.get("training_ids", [])):
        raise ValueError("Holdout contains training ids")
    if {row["group_id"] for row in rows}.intersection(training.get("training_group_ids", [])):
        raise ValueError("Holdout contains training groups")
    if args.limit:
        rows = rows[:args.limit]
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise ValueError("Choose a new evaluation output path")
    versions = package_versions()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from peft import PeftModel
    from multitask_rewards import score_completion
    gpu = require_single_gpu(torch)
    set_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
    tokenizer.pad_token = tokenizer.eos_token if tokenizer.pad_token is None else tokenizer.pad_token
    tokenizer.padding_side = "left"
    prompts = []
    for row in rows:
        inputs = tokenizer(render_prompt(tokenizer, row), return_tensors="pt", add_special_tokens=False)
        if inputs.input_ids.shape[1] + args.max_new_tokens > args.max_sequence_length:
            raise ValueError("Holdout prompt exceeds sequence budget: " + row["id"])
        prompts.append(inputs)
    model = AutoModelForCausalLM.from_pretrained(str(model_path), local_files_only=True,
                    trust_remote_code=False, use_safetensors=True, torch_dtype=torch.bfloat16,
                    attn_implementation="sdpa").to("cuda:0")
    model = PeftModel.from_pretrained(model, str(adapter_path), is_trainable=False, local_files_only=True).eval()
    model.config.use_cache = True
    results = []
    torch.cuda.reset_peak_memory_stats(0)
    for row, cpu_inputs in zip(rows, prompts):
        inputs = cpu_inputs.to("cuda:0")
        record = {"id": row["id"], "group_id": row["group_id"], "task": row["case"]["task"]}
        for variant in ("baseline", "adapter"):
            from contextlib import nullcontext
            mode = model.disable_adapter() if variant == "baseline" else nullcontext()
            with mode, torch.inference_mode():
                torch.cuda.synchronize(0)
                started = time.monotonic()
                generated = model.generate(**inputs, max_new_tokens=args.max_new_tokens,
                                           do_sample=False, pad_token_id=tokenizer.pad_token_id,
                                           eos_token_id=tokenizer.eos_token_id)
                torch.cuda.synchronize(0)
                elapsed = time.monotonic() - started
            tokens = generated[0, inputs.input_ids.shape[1]:]
            text = tokenizer.decode(tokens, skip_special_tokens=True).strip()
            score = score_completion(row["case"], text)
            record[variant] = {**score, "text": text, "generation_seconds": elapsed,
                               "tokens": int(tokens.numel()),
                               "truncated": bool(tokens.numel() and int(tokens[-1]) != tokenizer.eos_token_id)}
        results.append(record)
        print(json.dumps({"evaluated": len(results), "total": len(rows), "case_id": row["id"]}), flush=True)
    totals = {variant: summarize([row[variant] for row in results]) for variant in ("baseline", "adapter")}
    grouped = defaultdict(list)
    for row in results:
        grouped[row["task"]].append(row)
    report = {"model_name": training.get("model_name", "xim-chat-v1"), "status": "completed", "pilot_only": True, "configuration": vars(args), "versions": versions,
              "gpu": gpu, "holdout_sha256": file_hash(holdout),
              "evaluation_source_sha256": {name: file_hash(Path(__file__).with_name(name))
                                           for name in ("evaluate_multitask.py", "multitask_rewards.py")},
              "adapter_sha256": file_hash(adapter_path / "adapter_model.safetensors"),
              "training_stage": training["stage"], "training_steps": training["actual_steps"],
              "thinking_enabled": False, "same_prompts_and_decoding": True,
              "data_sources": sorted({row.get("source", "unknown") for row in rows}),
              "human_preference_evaluation": False, "real_voice_evaluation": False,
              "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated(0),
              "summary": totals,
              "per_task": {task: {v: summarize([row[v] for row in items]) for v in ("baseline", "adapter")}
                           for task, items in grouped.items()},
              "cases": results,
              "limitations": "Template holdout only; not evidence of human preference, natural conversation, actual task execution or voice latency."}
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output, report)
    print(json.dumps({"status": "completed", "summary": totals, "report": str(output), "pilot_only": True}))


if __name__ == "__main__":
    main()
