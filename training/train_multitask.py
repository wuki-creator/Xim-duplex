"""Offline single-GPU Qwen3-8B SFT / GRPO pilot, not a production training claim.

Requires explicit CUDA_VISIBLE_DEVICES with exactly one GPU. Only existing local
weights/data are accepted. API verified against TRL v0.23.1 trainer/config source:
https://github.com/huggingface/trl/tree/v0.23.1/trl/trainer
"""
import argparse
import datetime
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import time

PINNED = {"torch": "2.6.0", "transformers": "4.57.1", "trl": "0.23.1",
          "peft": "0.17.1", "accelerate": "1.10.1", "datasets": "4.1.1", "safetensors": "0.6.2"}


def offline_environment():
    # Set before importing any model libraries; never use runtime Hub downloads.
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        os.environ[key] = "1"
    os.environ["WANDB_DISABLED"] = "true"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_rows(path, split, require_case=True):
    rows = []
    seen = set()
    with Path(path).open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict) or row.get("split") != split or not isinstance(row.get("id"), str):
                raise ValueError("Invalid row or dataset split")
            if row["id"] in seen or (require_case and not isinstance(row.get("case"), dict)):
                raise ValueError("Duplicate id or missing case")
            if not isinstance(row.get("group_id"), str) or not row["group_id"]:
                raise ValueError("A group_id is required for leakage checks")
            prompt = row.get("prompt")
            if not isinstance(prompt, list) or not prompt or prompt[-1].get("role") != "user":
                raise ValueError("Expected a conversational prompt ending with a user message")
            if any(not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant")
                   or not isinstance(m.get("content"), str) for m in prompt):
                raise ValueError("Invalid prompt messages")
            seen.add(row["id"])
            rows.append(row)
    if not rows:
        raise ValueError("Empty dataset")
    return rows


def checked_model_dir(value):
    path = Path(value).expanduser().resolve()
    if not path.is_dir() or not (path / "config.json").is_file():
        raise ValueError("Provide an existing local Qwen3-8B model directory")
    config = json.loads((path / "config.json").read_text(encoding="utf-8"))
    if config.get("model_type") != "qwen3" or config.get("hidden_size") != 4096 or config.get("num_hidden_layers") != 36:
        raise ValueError("This pilot is configured for Qwen3-8B, not an arbitrary 6B/10B model")
    if not list(path.glob("*.safetensors")):
        raise ValueError("Local safetensors model weights are required")
    return path


def package_versions():
    versions = {name: importlib.metadata.version(name) for name in PINNED}
    for name, expected in PINNED.items():
        if versions[name].split("+")[0] != expected:
            raise ValueError("Expected %s==%s, found %s" % (name, expected, versions[name]))
    return versions


def require_single_gpu(torch):
    visible = os.environ.get("CUDA_VISIBLE_DEVICES", "")
    if not visible or len(visible.split(",")) != 1 or visible in ("-1", "none", "None"):
        raise ValueError("Set CUDA_VISIBLE_DEVICES explicitly to one selected GPU")
    if int(os.environ.get("WORLD_SIZE", "1")) != 1:
        raise ValueError("This memory-bounded pilot supports one process only")
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise ValueError("The selected CUDA GPU is not available")
    if not torch.cuda.is_bf16_supported():
        raise ValueError("The selected GPU must support BF16")
    torch.cuda.set_device(0)
    return {"selected_device": visible, "name": torch.cuda.get_device_name(0),
            "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory,
            "torch_cuda_build": torch.version.cuda}


def render_prompt(tokenizer, row):
    return tokenizer.apply_chat_template(row["prompt"], tokenize=False,
                                         add_generation_prompt=True, enable_thinking=False)


def tokenize_sft(tokenizer, rows, maximum):
    encoded = []
    for row in rows:
        completion = row.get("completion")
        if not isinstance(completion, list) or len(completion) != 1 or completion[0].get("role") != "assistant":
            raise ValueError("SFT requires one assistant completion")
        text = completion[0].get("content")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("SFT completion must contain assistant text")
        if row.get("case") is not None and not isinstance(json.loads(text), dict):
            raise ValueError("Task-schema SFT completion must be a JSON object string")
        prompt_ids = tokenizer.encode(render_prompt(tokenizer, row), add_special_tokens=False)
        target_ids = tokenizer.encode(text, add_special_tokens=False) + [tokenizer.eos_token_id]
        if len(prompt_ids) + len(target_ids) > maximum:
            raise ValueError("SFT row exceeds sequence limit; refusing silent target truncation: " + row["id"])
        encoded.append({"input_ids": prompt_ids + target_ids,
                        "completion_mask": [0] * len(prompt_ids) + [1] * len(target_ids)})
    return encoded


def prepare_grpo(tokenizer, rows, prompt_limit):
    result = []
    for row in rows:
        prompt = render_prompt(tokenizer, row)
        if len(tokenizer.encode(prompt, add_special_tokens=False)) > prompt_limit:
            raise ValueError("GRPO prompt exceeds limit; refusing hidden context truncation: " + row["id"])
        # Serialized metadata preserves task-specific keys without Arrow adding
        # null fields from unrelated tasks. It is never appended to the prompt.
        result.append({"prompt": prompt, "case": json.dumps(row["case"], ensure_ascii=False), "id": row["id"]})
    return result


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    temporary.replace(path)


def adapter_manifest(path):
    path = Path(path).expanduser().resolve()
    metadata = path / "run_manifest.json"
    if not metadata.is_file() or not (path / "adapter_config.json").is_file() or not (path / "adapter_model.safetensors").is_file():
        raise ValueError("A completed local pilot adapter and run_manifest.json are required")
    manifest = json.loads(metadata.read_text(encoding="utf-8"))
    if (not isinstance(manifest, dict) or manifest.get("status") != "completed"
            or manifest.get("stage") not in ("sft", "grpo")
            or type(manifest.get("actual_steps")) is not int or manifest["actual_steps"] < 1):
        raise ValueError("Adapter training has not completed")
    valid_hash = lambda value: isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None
    base_weights = manifest.get("base_weight_sha256")
    if (not valid_hash(manifest.get("base_config_sha256")) or not isinstance(base_weights, dict) or not base_weights
            or any(not isinstance(name, str) or Path(name).name != name or "/" in name or "\\" in name
                   or not name.endswith(".safetensors") or not valid_hash(value) for name, value in base_weights.items())):
        raise ValueError("Missing or invalid base weight fingerprints")
    weights = path / "adapter_model.safetensors"
    if (weights.stat().st_size == 0 or not valid_hash(manifest.get("adapter_sha256"))
            or file_hash(weights) != manifest["adapter_sha256"]):
        raise ValueError("Adapter checkpoint checksum mismatch")
    config = json.loads((path / "adapter_config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("peft_type") != "LORA" or config.get("task_type") != "CAUSAL_LM":
        raise ValueError("Only causal language model LoRA adapters are supported")
    # Older pilot manifests did not record the config hash. Verify it whenever
    # present; the tensor checksum and LoRA/CAUSAL_LM contract are always required.
    if "adapter_config_sha256" in manifest and (not valid_hash(manifest["adapter_config_sha256"])
            or file_hash(path / "adapter_config.json") != manifest["adapter_config_sha256"]):
        raise ValueError("Adapter configuration checksum mismatch")
    return path, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("sft", "grpo"), required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sft-adapter")
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--max-sequence-length", type=int, default=1024)
    parser.add_argument("--max-completion-length", type=int, default=192)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--num-generations", type=int, default=4)
    parser.add_argument("--learning-rate", type=float)
    parser.add_argument("--lora-targets", choices=("qv", "all-linear"), default="qv")
    parser.add_argument("--beta", type=float, default=0.04)
    parser.add_argument("--seed", type=int, default=3407)
    args = parser.parse_args()
    offline_environment()
    args.max_steps = args.max_steps if args.max_steps is not None else (20 if args.stage == "sft" else 8)
    args.learning_rate = args.learning_rate if args.learning_rate is not None else (1e-4 if args.stage == "sft" else 5e-6)
    if args.max_steps < 1 or not 128 <= args.max_sequence_length <= 1024 or not 16 <= args.max_completion_length < args.max_sequence_length:
        parser.error("Positive steps and a 128..1024 token sequence limit are required")
    if args.gradient_accumulation_steps < 1 or args.learning_rate <= 0:
        parser.error("Invalid accumulation or learning rate")
    if args.stage == "grpo" and (not args.sft_adapter or args.beta <= 0 or args.num_generations < 2
                                 or args.gradient_accumulation_steps % args.num_generations):
        parser.error("GRPO requires a local SFT adapter, positive KL beta and accumulation divisible by num-generations>=2")
    model_path = checked_model_dir(args.model_dir)
    data_path = Path(args.data).expanduser().resolve()
    rows = read_rows(data_path, "train", require_case=args.stage == "grpo")
    output = Path(args.output).expanduser().resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Use a new output directory; existing training artifacts are not overwritten")
    parent = None
    if args.stage == "grpo":
        adapter_path, parent = adapter_manifest(args.sft_adapter)
        if parent.get("stage") != "sft" or parent.get("base_config_sha256") != file_hash(model_path / "config.json"):
            parser.error("GRPO must continue an SFT adapter for this exact base configuration")
    versions = package_versions()
    import torch
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from peft import LoraConfig, PeftModel, get_peft_model
    from trl import SFTConfig, SFTTrainer, GRPOConfig, GRPOTrainer
    from multitask_rewards import multitask_reward, score_completion
    gpu = require_single_gpu(torch)
    set_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
    if tokenizer.eos_token_id is None:
        raise ValueError("Tokenizer EOS is required")
    tokenizer.pad_token = tokenizer.eos_token if tokenizer.pad_token is None else tokenizer.pad_token
    tokenizer.padding_side = "right" if args.stage == "sft" else "left"
    encoded = (tokenize_sft(tokenizer, rows, args.max_sequence_length) if args.stage == "sft"
               else prepare_grpo(tokenizer, rows, args.max_sequence_length - args.max_completion_length))
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"model_name": "xim-chat-v1", "status": "starting", "pilot_only": True, "stage": args.stage, "actual_steps": 0,
                "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "configuration": vars(args), "versions": versions, "gpu": gpu,
                "base_model": "Qwen/Qwen3-8B", "base_model_path": str(model_path),
                "training_source_sha256": {name: file_hash(Path(__file__).with_name(name))
                                           for name in ("train_multitask.py", "multitask_rewards.py")},
                "base_config_sha256": file_hash(model_path / "config.json"),
                "tokenizer_sha256": {name: file_hash(model_path / name)
                                     for name in ("tokenizer.json", "tokenizer_config.json")},
                "base_weight_sha256": {path.name: file_hash(path) for path in sorted(model_path.glob("*.safetensors"))},
                "dataset_sha256": file_hash(data_path), "rows": len(rows),
                "stage_training_ids": [row["id"] for row in rows],
                "training_ids": sorted({row["id"] for row in rows} | set((parent or {}).get("training_ids", []))),
                "training_group_ids": sorted({row["group_id"] for row in rows} | set((parent or {}).get("training_group_ids", []))),
                "data_sources": sorted({row.get("source", "unknown") for row in rows}),
                "synthetic_rows": sum(row.get("synthetic") is True for row in rows),
                "thinking_enabled": False, "report_to": "none", "offline": True,
                "kl_reference": "frozen_base_with_adapter_disabled" if args.stage == "grpo" else None,
                "parent_adapter": str(adapter_path) if parent else None,
                "parent_adapter_sha256": file_hash(adapter_path / "adapter_model.safetensors") if parent else None,
                "parent_dataset_sha256": parent.get("dataset_sha256") if parent else None,
                "quality_claim": "No human quality, real speech or deployment validation is implied by this pilot."}
    atomic_json(output / "run_manifest.json", manifest)
    if parent and parent.get("base_weight_sha256") != manifest["base_weight_sha256"]:
        manifest.update(status="failed", error_type="BaseWeightMismatch")
        atomic_json(output / "run_manifest.json", manifest)
        raise ValueError("SFT adapter was trained against different base weights")
    torch.cuda.reset_peak_memory_stats(0)
    trainer = None
    reward_audit = {"calls": 0, "sampled_completions": 0, "tasks": {}}
    started = time.monotonic()
    try:
        model = AutoModelForCausalLM.from_pretrained(str(model_path), local_files_only=True,
                    trust_remote_code=False, use_safetensors=True, torch_dtype=torch.bfloat16,
                    attn_implementation="sdpa").to("cuda:0")
        base_parameters = sum(parameter.numel() for parameter in model.parameters())
        model.config.use_cache = False
        if args.stage == "sft":
            targets = ["q_proj", "v_proj"] if args.lora_targets == "qv" else ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
            model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.0,
                                  bias="none", task_type="CAUSAL_LM", target_modules=targets))
        else:
            model = PeftModel.from_pretrained(model, str(adapter_path), is_trainable=True, local_files_only=True)
        model.enable_input_require_grads()
        common = dict(output_dir=str(output), max_steps=args.max_steps, per_device_train_batch_size=1,
                      gradient_accumulation_steps=args.gradient_accumulation_steps, learning_rate=args.learning_rate,
                      bf16=True, fp16=False, gradient_checkpointing=True,
                      gradient_checkpointing_kwargs={"use_reentrant": False}, optim="adamw_torch",
                      lr_scheduler_type="constant", warmup_steps=0, max_grad_norm=1.0,
                      logging_steps=1, save_strategy="no", eval_strategy="no", report_to="none",
                      seed=args.seed, data_seed=args.seed, dataloader_num_workers=0, push_to_hub=False)
        if args.stage == "sft":
            config = SFTConfig(**common, max_length=args.max_sequence_length, packing=False,
                               completion_only_loss=True, dataset_kwargs={"skip_prepare_dataset": True})
            trainer = SFTTrainer(model=model, args=config, train_dataset=Dataset.from_list(encoded), processing_class=tokenizer)
        else:
            def task_reward(completions, case=None, **kwargs):
                cases = [json.loads(item) if isinstance(item, str) else item for item in (case or [])]
                if len(cases) != len(completions):
                    raise ValueError("GRPO completion/reference alignment failed")
                rewards = multitask_reward(completions, case=cases, **kwargs)
                # Audit the candidates actually sampled, rather than treating all
                # rows in the input file as observed training experience.
                reward_audit["calls"] += 1
                reward_audit["sampled_completions"] += len(completions)
                ids = kwargs.get("id")
                if not isinstance(ids, list) or len(ids) != len(completions):
                    raise ValueError("GRPO must preserve per-completion dataset ids")
                groups = {}
                for identity, reference, completion, reward in zip(ids, cases, completions, rewards):
                    task = reference["task"]
                    stats = reward_audit["tasks"].setdefault(task, {"samples": 0, "correct": 0,
                        "legal": 0, "groups": 0, "groups_with_reward_variance": 0, "reward_sum": 0.0})
                    score = score_completion(reference, completion)
                    stats["samples"] += 1
                    stats["correct"] += int(score["correct"])
                    stats["legal"] += int(score["legal"])
                    stats["reward_sum"] += reward
                    groups.setdefault((task, identity), []).append(reward)
                for (task, _), values in groups.items():
                    stats = reward_audit["tasks"][task]
                    stats["groups"] += 1
                    stats["groups_with_reward_variance"] += int(max(values) > min(values))
                return rewards
            # Single process, batch=1: generation batch = accumulation (4 by
            # default), divisible by num_generations. No extra vLLM/GPU replica.
            config = GRPOConfig(**common, max_prompt_length=args.max_sequence_length - args.max_completion_length,
                                max_completion_length=args.max_completion_length,
                                generation_batch_size=args.gradient_accumulation_steps,
                                num_generations=args.num_generations, beta=args.beta,
                                temperature=0.8, top_p=0.95, top_k=20, use_vllm=False,
                                loss_type="grpo", scale_rewards="group", mask_truncated_completions=True,
                                log_completions=False)
            trainer = GRPOTrainer(model=model, reward_funcs=task_reward, args=config,
                                  train_dataset=Dataset.from_list(encoded), processing_class=tokenizer)
        manifest.update(status="running", base_parameters=base_parameters,
                        total_parameters=sum(p.numel() for p in model.parameters()),
                        trainable_params=sum(p.numel() for p in model.parameters() if p.requires_grad),
                        trainer_configuration=config.to_dict())
        atomic_json(output / "run_manifest.json", manifest)
        initial_trainable = {name: parameter.detach().float().cpu().clone()
                             for name, parameter in model.named_parameters() if parameter.requires_grad}
        result = trainer.train()
        if trainer.state.global_step < args.max_steps:
            raise RuntimeError("Training stopped before the requested pilot steps")
        trainer.save_model(str(output))
        tokenizer.save_pretrained(str(output))
        trainer.save_state()
        if not (output / "adapter_model.safetensors").is_file():
            raise RuntimeError("No adapter checkpoint was saved")
        squared_change = sum(float((parameter.detach().float().cpu() - initial_trainable[name]).square().sum())
                             for name, parameter in model.named_parameters() if name in initial_trainable)
        if not math.isfinite(squared_change):
            raise RuntimeError("Non-finite adapter parameters; refusing a completed checkpoint")
        manifest.update(status="completed", actual_steps=trainer.state.global_step,
                        metrics=result.metrics, adapter_checkpoint=str(output / "adapter_model.safetensors"),
                        trainable_delta_l2=squared_change ** 0.5, parameters_changed=squared_change > 0,
                        adapter_sha256=file_hash(output / "adapter_model.safetensors"),
                        adapter_config_sha256=file_hash(output / "adapter_config.json"))
    except BaseException as error:
        manifest.update(status="failed", error_type=type(error).__name__,
                        actual_steps=trainer.state.global_step if trainer else 0)
        raise
    finally:
        manifest.update(elapsed_seconds=time.monotonic() - started,
                        reward_audit=reward_audit if args.stage == "grpo" else None,
                        peak_cuda_allocated_bytes=torch.cuda.max_memory_allocated(0),
                        peak_cuda_reserved_bytes=torch.cuda.max_memory_reserved(0),
                        finished_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
        atomic_json(output / "run_manifest.json", manifest)
    print(json.dumps({"status": manifest["status"], "stage": args.stage,
                      "actual_steps": manifest["actual_steps"], "adapter": str(output), "pilot_only": True}))


if __name__ == "__main__":
    main()
