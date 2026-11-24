"""Start the local CPU voice demo with pinned Whisper Tiny and Qwen2.5-0.5B models."""
import argparse
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
from urllib.request import urlopen

import ctranslate2
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from local_chat_worker import chat_handler, file_hash

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "Xim" / "voice-test"
MODEL = "Qwen2.5-0.5B-Instruct-INT8"


def model_files(repo, revision, directory, names, digest):
    weights = directory / "model.bin"
    corrupt = weights.is_file() and file_hash(weights) != digest
    complete = all((directory / name).is_file() and (directory / name).stat().st_size for name in names)
    if corrupt or not complete:
        snapshot_download(repo_id=repo, revision=revision, local_dir=str(directory),
                          allow_patterns=names, force_download=corrupt)
        if file_hash(weights) != digest:
            raise RuntimeError(f"Downloaded weights do not match the pinned version of {repo}")
    return directory


def cpu_generator(directory):
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    model = ctranslate2.Generator(str(directory), device="cpu", compute_type="int8", intra_threads=4)

    def generate(messages, limit):
        # Qwen ChatML wraps each turn. Encode user content without interpreting control tokens.
        tokenizer.encode_special_tokens = True
        tokens = []
        for message in messages:
            tokens += ["<|im_start|>"] + tokenizer.encode(message["role"] + "\n" + message["content"],
                                                          add_special_tokens=False).tokens
            tokens += ["<|im_end|>"] + tokenizer.encode("\n", add_special_tokens=False).tokens
        tokens += ["<|im_start|>"] + tokenizer.encode("assistant\n", add_special_tokens=False).tokens
        if len(tokens) + limit > 8192:
            raise ValueError("input too long")
        result = model.generate_batch([tokens], max_length=limit, beam_size=1, repetition_penalty=1.08,
                                      end_token="<|im_end|>", return_end_token=True,
                                      include_prompt_in_result=False)[0]
        ids = result.sequences_ids[0]
        finished = bool(ids) and (ids[-1] == tokenizer.token_to_id("<|im_end|>") or len(ids) < limit)
        return {"choices": [{"message": {"role": "assistant", "content": tokenizer.decode(ids)},
                             "finish_reason": "stop" if finished else "length"}]}
    return generate


def local_server(port=0):
    with socket.socket() as sock:
        if os.name == "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind(("127.0.0.1", port))
        return sock.getsockname()[1]


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def wait_ready(child, url, keys):
    deadline = time.monotonic() + 120
    while child.poll() is None and time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                state = json.load(response)
            if all(state.get(key) == value for key, value in keys.items()):
                return
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise RuntimeError(f"Service did not become ready at {url} (exit={child.poll()})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8790)
    port = parser.parse_args().port
    if not 1 <= port <= 65535:
        parser.error("port must be between 1 and 65535")
    local_server(port)  # Detect a busy web port before downloading weights.
    qwen = model_files("jncraton/Qwen2.5-0.5B-Instruct-ct2-int8", "4c6321ff9d93b9c0d838e4cfa1397eb75cea5ceb",
                       CACHE / "qwen-ct2", ["model.bin", "config.json", "vocabulary.json", "tokenizer.json"],
                       "b6d8dda7a5dffe272726b782102f3181c409d049e014e809d80363578be921fc")
    whisper = model_files("Systran/faster-whisper-tiny", "d90ca5fe260221311c53c58e660288d3deb8d356",
                          CACHE / "whisper-tiny", ["model.bin", "config.json", "vocabulary.txt", "tokenizer.json"],
                          "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1")
    handler = chat_handler(cpu_generator(qwen), MODEL, "Qwen/Qwen2.5-0.5B-Instruct")
    with ExitStack() as stack:
        chat = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), handler))
        threading.Thread(target=chat.serve_forever, daemon=True).start()
        stack.callback(chat.shutdown)
        asr_port = local_server()
        asr_url = f"http://127.0.0.1:{asr_port}"
        env = dict(os.environ, ASR_ENGINE="whisper", ASR_DEVICE="cpu", ASR_COMPUTE_TYPE="int8", ASR_THREADS="4",
                   ASR_INITIAL_PROMPT="以下是简体中文普通话。", ASR_MODEL=str(whisper), ASR_MODEL_LABEL="Whisper Tiny", ASR_PORT=str(asr_port), ASR_URL=asr_url,
                   XIM_LOCAL_CHAT_URL=f"http://127.0.0.1:{chat.server_port}", XIM_LOCAL_CHAT_MODEL=MODEL,
                   HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
        for key in ("XIM_LOCAL_TTS_URL", "XIM_LOCAL_TTS_MODEL", "XIM_LOCAL_IMAGE_URL", "XIM_LOCAL_IMAGE_MODEL",
                    "XIM_COMPUTE_URL", "XIM_TURN_URL"):
            env.pop(key, None)
        asr = subprocess.Popen([sys.executable, "scripts/asr_worker.py"], cwd=ROOT, env=env)
        stack.callback(stop_child, asr)
        wait_ready(asr, asr_url + "/health", {"ready": True, "model": "Whisper Tiny"})
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 22+ is required")
        site = subprocess.Popen([node, "server.mjs", "--small-model", "--port", str(port)], cwd=ROOT, env=env)
        stack.callback(stop_child, site)
        url = f"http://127.0.0.1:{port}"
        wait_ready(site, url + "/api/bootstrap", {"configured": True, "asrReady": True, "model": MODEL})
        print(f"Ready: {url} (Whisper Tiny + {MODEL}). Press Ctrl+C to stop.", flush=True)
        while asr.poll() is None and site.poll() is None:
            time.sleep(.5)
        raise RuntimeError(f"Demo process exited (web={site.poll()}, ASR={asr.poll()})")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
