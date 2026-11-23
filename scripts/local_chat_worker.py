"""Loopback-only offline Qwen inference with optional explicitly selected LoRA.

Importing this module does not load models, allocate a GPU or start a server.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def offline_environment():
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        os.environ[key] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


def file_hash(path):
    checksum = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def validate_adapter(model_dir, adapter_dir):
    """Require completed training and the exact base/adapter bytes in its manifest."""
    base, adapter = Path(model_dir).resolve(), Path(adapter_dir).resolve()
    for path in (base / "config.json", adapter / "run_manifest.json",
                 adapter / "adapter_config.json", adapter / "adapter_model.safetensors"):
        if not path.is_file():
            raise ValueError("A complete local base and trained safetensors adapter are required")
    manifest = json.loads((adapter / "run_manifest.json").read_text(encoding="utf-8"))
    steps = manifest.get("actual_steps")
    if (manifest.get("status") != "completed" or type(steps) is not int or steps < 1
            or manifest.get("stage") not in ("sft", "grpo")):
        raise ValueError("Adapter training has not completed")
    if manifest.get("base_config_sha256") != file_hash(base / "config.json"):
        raise ValueError("Adapter base configuration mismatch")
    weights = {p.name: file_hash(p) for p in sorted(base.glob("*.safetensors"))}
    if not weights or manifest.get("base_weight_sha256") != weights:
        raise ValueError("Adapter base weight mismatch")
    adapter_hash = file_hash(adapter / "adapter_model.safetensors")
    if manifest.get("adapter_sha256") != adapter_hash:
        raise ValueError("Adapter checkpoint checksum mismatch")
    config = json.loads((adapter / "adapter_config.json").read_text(encoding="utf-8"))
    if config.get("peft_type") != "LORA" or config.get("task_type") != "CAUSAL_LM":
        raise ValueError("Only causal language model LoRA adapters are supported")
    return {"path": str(adapter), "stage": manifest["stage"], "actual_steps": steps,
            "sha256": adapter_hash, "base_model": manifest.get("base_model", "Qwen3-8B"),
            "pilot_only": manifest.get("pilot_only") is True}


def validate_request(data, served_model):
    if not isinstance(data, dict):
        raise ValueError("body")
    messages = data.get("messages")
    if data.get("model") != served_model or not isinstance(messages, list) or not 1 <= len(messages) <= 14:
        raise ValueError("model or messages")
    if any(not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant")
           or not isinstance(m.get("content"), str) or len(m["content"]) > 12000 for m in messages):
        raise ValueError("messages")
    requested = data.get("max_tokens", 400)
    if type(requested) is not int:
        raise ValueError("max_tokens")
    return messages, min(1200, max(1, requested))


def generate_reply(tokenizer, model, messages, limit, *, device, max_input_tokens, inference_mode):
    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                           enable_thinking=False)
    inputs = tokenizer(prompt, return_tensors="pt", add_special_tokens=False)
    prompt_length = inputs.input_ids.shape[1]
    if prompt_length > max_input_tokens:
        raise ValueError("input token limit")
    context_limit = getattr(model.config, "max_position_embeddings", None)
    if isinstance(context_limit, int) and prompt_length + limit > context_limit:
        raise ValueError("context token limit")
    inputs = inputs.to(device)
    with inference_mode():
        output = model.generate(**inputs, max_new_tokens=limit, do_sample=False, use_cache=True,
                                pad_token_id=tokenizer.eos_token_id, eos_token_id=tokenizer.eos_token_id)
    new = output[0][prompt_length:]
    # Check BEFORE removing special tokens: removing <think> alone can expose its
    # contents. Reject an unexpected reasoning channel without returning/logging it.
    raw = tokenizer.decode(new, skip_special_tokens=False)
    if re.search(r"<\s*/?\s*(?:think|analysis)(?:\s|>)", raw, re.IGNORECASE):
        raise RuntimeError("Unexpected reasoning channel")
    content = tokenizer.decode(new, skip_special_tokens=True).strip()
    if not content:
        raise RuntimeError("Empty response")
    stopped = len(new) < limit or (len(new) > 0 and int(new[-1]) == tokenizer.eos_token_id)
    return {"choices": [{"message": {"role": "assistant", "content": content},
                         "finish_reason": "stop" if stopped else "length"}]}


def make_handler(*, tokenizer, model, served_model, base_model, adapter, max_input_tokens, inference_mode):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No prompts, replies or private model paths in logs.

        def send_json(self, status, data):
            encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if self.path != "/health":
                return self.send_json(404, {"error": "not_found"})
            result = {"ready": True, "model": served_model, "base_model": base_model,
                      "adapter": bool(adapter), "thinking_enabled": False, "offline": True}
            if adapter:
                result.update(adapter_stage=adapter["stage"], adapter_steps=adapter["actual_steps"],
                              adapter_sha256=adapter["sha256"], adapter_pilot_only=adapter["pilot_only"])
            self.send_json(200, result)

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                return self.send_json(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 64000:
                    raise ValueError("body")
                messages, limit = validate_request(json.loads(self.rfile.read(length)), served_model)
                if not lock.acquire(timeout=30):
                    return self.send_json(503, {"error": "busy"})
                try:
                    result = generate_reply(tokenizer, model, messages, limit, device="cuda:0",
                                            max_input_tokens=max_input_tokens, inference_mode=inference_mode)
                finally:
                    lock.release()
                self.send_json(200, result)
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                self.send_json(400, {"error": "invalid_input"})
            except Exception as error:
                print("inference_failed:", type(error).__name__, flush=True)
                self.send_json(500, {"error": "inference_failed"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-name", default="Qwen2.5-1.5B-Instruct")
    parser.add_argument("--port", type=int, default=18797)
    parser.add_argument("--adapter", help="Explicit local adapter with a completed, matching training manifest")
    parser.add_argument("--max-input-tokens", type=int, default=8192)
    parser.add_argument("--gpu-memory-fraction", type=float, default=1.0,
                        help="Upper bound on this process's PyTorch GPU allocator")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 128 <= args.max_input_tokens <= 32768:
        parser.error("Invalid port or input token limit")
    if not 0 < args.gpu_memory_fraction <= 1:
        parser.error("GPU memory fraction must be in (0, 1]")
    offline_environment()
    base = Path(args.model_dir).expanduser().resolve()
    if not base.is_dir() or not (base / "config.json").is_file():
        parser.error("An existing local model directory is required")
    config = json.loads((base / "config.json").read_text(encoding="utf-8"))
    adapter = validate_adapter(base, args.adapter) if args.adapter else None
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required")
    torch.cuda.set_per_process_memory_fraction(args.gpu_memory_fraction, 0)
    dtype = torch.bfloat16 if config.get("model_type") == "qwen3" else torch.float16
    if dtype == torch.bfloat16 and not torch.cuda.is_bf16_supported():
        raise RuntimeError("This Qwen3 worker requires a BF16-capable GPU")
    tokenizer = AutoTokenizer.from_pretrained(str(base), local_files_only=True, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(str(base), local_files_only=True, trust_remote_code=False,
                                               torch_dtype=dtype).to("cuda:0")
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter["path"], is_trainable=False, local_files_only=True)
    model.eval()
    model.config.use_cache = True
    handler = make_handler(tokenizer=tokenizer, model=model, served_model=args.model_name,
                           base_model=adapter["base_model"] if adapter else args.model_name,
                           adapter=adapter, max_input_tokens=args.max_input_tokens,
                           inference_mode=torch.inference_mode)
    ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
