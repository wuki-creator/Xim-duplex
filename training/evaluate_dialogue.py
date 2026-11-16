"""Offline paired Qwen3-8B / adapter checks on prepared OASST2 validation data.

Measures reference-completion token NLL and generates plain text for optional
review. NLL is not subjective naturalness, factual accuracy or human preference.
No tools or model-generated code are executed. Nothing is downloaded at runtime.
"""
import argparse
from contextlib import nullcontext
import json
import math
from pathlib import Path
import re
import time

from train_multitask import (adapter_manifest, atomic_json, checked_model_dir, file_hash,
                            offline_environment, package_versions, read_rows, render_prompt,
                            require_single_gpu)


def validate_rows(rows, training):
    """Require official-validation provenance and full ancestor leakage metadata."""
    train_ids, train_groups = training.get("training_ids"), training.get("training_group_ids")
    if (not isinstance(train_ids, list) or not train_ids or not all(isinstance(item, str) for item in train_ids)
            or not isinstance(train_groups, list) or not train_groups or not all(isinstance(item, str) for item in train_groups)):
        raise ValueError("Training ids and groups are required to check validation isolation")
    if {row["id"] for row in rows}.intersection(train_ids):
        raise ValueError("Validation contains an ancestor training id")
    if {row["group_id"] for row in rows}.intersection(train_groups):
        raise ValueError("Validation contains an ancestor training conversation tree")
    for row in rows:
        if (row.get("source") != "OpenAssistant/oasst2" or row.get("source_split") != "validation"
                or row.get("synthetic") is not False or row.get("license") != "Apache-2.0"
                or not re.fullmatch(r"[a-f0-9]{40}", row.get("dataset_revision", ""))
                or not re.fullmatch(r"[a-f0-9]{64}", row.get("source_sha256", ""))):
            raise ValueError("Expected prepared official OASST2 validation provenance")
        completion = row.get("completion")
        if (not isinstance(completion, list) or len(completion) != 1 or not isinstance(completion[0], dict)
                or completion[0].get("role") != "assistant" or not isinstance(completion[0].get("content"), str)
                or not completion[0]["content"].strip()):
            raise ValueError("One nonempty reference assistant completion is required")
        if sum(len(message["content"]) for message in row["prompt"]) + len(completion[0]["content"]) > 800:
            raise ValueError("Prepared conversation exceeds the existing 800-character source limit")


def summarize(values):
    count = len(values)
    reference_tokens = sum(value["reference_tokens"] for value in values)
    latencies = sorted(value["generation_seconds"] for value in values)
    token_nll = sum(value["reference_nll_sum"] for value in values) / reference_tokens
    return {"examples": count, "reference_tokens_including_eos": reference_tokens,
            "reference_token_nll": token_nll,
            "reference_perplexity": math.exp(token_nll) if token_nll < 700 else None,
            "truncated_rate": sum(value["truncated"] for value in values) / count,
            "empty_generation_rate": sum(value["empty"] for value in values) / count,
            "reasoning_channel_rejection_rate": sum(value["reasoning_channel_rejected"] for value in values) / count,
            "mean_generated_tokens": sum(value["generated_tokens"] for value in values) / count,
            "mean_generation_seconds": sum(latencies) / count,
            "p50_generation_seconds": latencies[math.ceil(count * .5) - 1],
            "p95_generation_seconds": latencies[math.ceil(count * .95) - 1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--validation", required=True, help="Prepared public-sft-validation.jsonl, normally 16 rows")
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=0, help="0 evaluates every supplied validation row")
    parser.add_argument("--max-sequence-length", type=int, default=1024)
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--include-examples", action="store_true", help="Include source prompt/reference and generated text in the local report")
    args = parser.parse_args()
    offline_environment()
    if args.limit < 0 or not 128 <= args.max_sequence_length <= 1024 or not 16 <= args.max_new_tokens < args.max_sequence_length:
        parser.error("Invalid evaluation limits")
    model_path = checked_model_dir(args.model_dir)
    adapter_path, training = adapter_manifest(args.adapter)
    if training["base_config_sha256"] != file_hash(model_path / "config.json"):
        raise ValueError("Adapter and baseline base configurations differ")
    weights = {path.name: file_hash(path) for path in sorted(model_path.glob("*.safetensors"))}
    if training["base_weight_sha256"] != weights:
        raise ValueError("Adapter and baseline base weights differ")
    source = Path(args.validation).expanduser().resolve()
    rows = read_rows(source, "validation", require_case=False)
    validate_rows(rows, training)
    if args.limit:
        rows = rows[:args.limit]
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise ValueError("Choose a new evaluation output path")
    versions = package_versions()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from peft import PeftModel
    gpu = require_single_gpu(torch)
    set_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
    if tokenizer.eos_token_id is None:
        raise ValueError("A tokenizer EOS token is required")
    tokenizer.pad_token = tokenizer.eos_token if tokenizer.pad_token is None else tokenizer.pad_token
    tokenizer.padding_side = "left"
    encoded = []
    for row in rows:
        prompt_ids = tokenizer.encode(render_prompt(tokenizer, row), add_special_tokens=False)
        target_ids = tokenizer.encode(row["completion"][0]["content"], add_special_tokens=False) + [tokenizer.eos_token_id]
        if not prompt_ids or len(prompt_ids) + max(len(target_ids), args.max_new_tokens) > args.max_sequence_length:
            raise ValueError("Validation row exceeds the sequence budget; no silent truncation: " + row["id"])
        encoded.append((prompt_ids, target_ids))
    model = AutoModelForCausalLM.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False,
                    use_safetensors=True, torch_dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda:0")
    model = PeftModel.from_pretrained(model, str(adapter_path), is_trainable=False, local_files_only=True).eval()
    model.config.use_cache = True
    torch.cuda.reset_peak_memory_stats(0)
    results = []
    for index, (row, (prompt_ids, target_ids)) in enumerate(zip(rows, encoded)):
        prompt = torch.tensor([prompt_ids], dtype=torch.long, device="cuda:0")
        full = torch.tensor([prompt_ids + target_ids], dtype=torch.long, device="cuda:0")
        labels = full.clone()
        labels[:, :len(prompt_ids)] = -100
        record = {key: row[key] for key in ("id", "group_id", "source", "source_split", "dataset_revision", "license", "source_sha256")}
        if args.include_examples:
            record.update(prompt=row["prompt"], reference_completion=row["completion"][0]["content"])
        # Alternate order to reduce systematic first/second-model timing bias.
        order = ("baseline", "adapter") if index % 2 == 0 else ("adapter", "baseline")
        for variant in order:
            mode = model.disable_adapter() if variant == "baseline" else nullcontext()
            with mode, torch.inference_mode():
                reference_output = model(input_ids=full, attention_mask=torch.ones_like(full), labels=labels, use_cache=False)
                nll = float(reference_output.loss.float().item())
                del reference_output
                if not math.isfinite(nll):
                    raise RuntimeError("Non-finite reference completion NLL")
                torch.cuda.synchronize(0)
                started = time.monotonic()
                generated = model.generate(input_ids=prompt, attention_mask=torch.ones_like(prompt),
                                           max_new_tokens=args.max_new_tokens, do_sample=False, use_cache=True,
                                           pad_token_id=tokenizer.pad_token_id, eos_token_id=tokenizer.eos_token_id)
                torch.cuda.synchronize(0)
                elapsed = time.monotonic() - started
            tokens = generated[0, len(prompt_ids):]
            raw = tokenizer.decode(tokens, skip_special_tokens=False)
            rejected = bool(re.search(r"<\s*/?\s*(?:think|analysis)(?:\s|>)", raw, re.IGNORECASE))
            text = None if rejected else tokenizer.decode(tokens, skip_special_tokens=True).strip()
            record[variant] = {"reference_tokens": len(target_ids), "reference_token_nll": nll,
                               "reference_nll_sum": nll * len(target_ids),
                               "generated_tokens": int(tokens.numel()), "generation_seconds": elapsed,
                               "truncated": bool(tokens.numel() and int(tokens[-1]) != tokenizer.eos_token_id),
                               "empty": not rejected and not text, "reasoning_channel_rejected": rejected}
            if args.include_examples:
                record[variant]["generated_text"] = text
        results.append(record)
        print(json.dumps({"evaluated": len(results), "total": len(rows), "case_id": row["id"]}), flush=True)
    summaries = {variant: summarize([row[variant] for row in results]) for variant in ("baseline", "adapter")}
    report = {"status": "completed", "pilot_only": True, "model_name": training.get("model_name", "xim-chat-v1"),
              "configuration": vars(args), "versions": versions, "gpu": gpu,
              "validation_sha256": file_hash(source), "adapter_sha256": file_hash(adapter_path / "adapter_model.safetensors"),
              "base_config_sha256": training["base_config_sha256"], "base_weight_sha256": weights,
              "evaluation_source_sha256": file_hash(Path(__file__)),
              "training_stage": training["stage"], "training_steps": training["actual_steps"],
              "dataset": {"name": "OpenAssistant/oasst2", "url": "https://huggingface.co/datasets/OpenAssistant/oasst2",
                          "license": "Apache-2.0", "source_split": "validation", "max_source_characters": 800,
                          "revisions": sorted({row["dataset_revision"] for row in rows}),
                          "source_sha256": sorted({row["source_sha256"] for row in rows})},
              "thinking_enabled": False, "same_prompts_and_decoding": True, "generation_order_alternated": True,
              "reference_loss_scope": "Assistant completion tokens including EOS; prompt tokens masked; token-weighted aggregation.",
              "tools_executed": False, "human_preference_evaluation": False, "real_voice_evaluation": False,
              "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated(0),
              "summary": summaries,
              "adapter_minus_baseline_reference_token_nll": summaries["adapter"]["reference_token_nll"] - summaries["baseline"]["reference_token_nll"],
              "cases": results,
              "limitations": ["Reference-token NLL is predictive fit to these references, not subjective naturalness, factual accuracy or human preference.",
                              "These are a small, filtered official validation sample, not a blind final test or a product-dialogue regression suite.",
                              "Generation timing excludes ASR, TTS, networking and human turn-taking; it is not an end-to-end speech latency claim.",
                              "No word-overlap heuristic or automatic product-quality promotion is used."]}
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output, report)
    print(json.dumps({"status": "completed", "summary": summaries, "report": str(output), "pilot_only": True}))


if __name__ == "__main__":
    main()
