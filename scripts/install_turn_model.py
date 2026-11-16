"""Explicit, pinned download of the upstream Smart Turn v3.2 CPU checkpoint."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

MODEL_REPO = "pipecat-ai/smart-turn-v3"
REVISION = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93"
MODEL_FILE = "smart-turn-v3.2-cpu.onnx"
SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"
SIZE = 8679182
SOURCE_REVISION = "4e12f2bbef04e47c348836f57100885f6973a5ae"


def download(url, destination, expected_sha=None, expected_size=None):
    temporary = destination.with_suffix(destination.suffix + ".part")
    digest = hashlib.sha256()
    count = 0
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Xim-turn-model-installer"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as out:
            while chunk := source.read(1024 * 1024):
                count += len(chunk)
                if count > (expected_size or 100_000):
                    raise ValueError("unexpected_download_size")
                digest.update(chunk)
                out.write(chunk)
        if expected_size is not None and count != expected_size:
            raise ValueError("checkpoint_size_mismatch")
        if expected_sha and digest.hexdigest() != expected_sha:
            raise ValueError("checkpoint_checksum_mismatch")
        os.replace(temporary, destination)
        return digest.hexdigest()
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "smart-turn")
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    checkpoint = args.destination / MODEL_FILE
    if not checkpoint.exists() or hashlib.sha256(checkpoint.read_bytes()).hexdigest() != SHA256:
        download(f"https://huggingface.co/{MODEL_REPO}/resolve/{REVISION}/{MODEL_FILE}", checkpoint, SHA256, SIZE)
    license_url = f"https://raw.githubusercontent.com/pipecat-ai/smart-turn/{SOURCE_REVISION}/LICENSE"
    license_sha = download(license_url, args.destination / "LICENSE.smart-turn")
    manifest = {
        "model": "smart-turn-v3.2-cpu", "repo": MODEL_REPO, "revision": REVISION,
        "file": MODEL_FILE, "sha256": SHA256, "size": SIZE,
        "license": "BSD-2-Clause", "license_source": license_url, "license_sha256": license_sha,
        "upstream_source_revision": SOURCE_REVISION,
        "input": "16 kHz mono PCM16 LE; keep last 8 seconds and left-pad",
        "status": "upstream pretrained checkpoint; not Xim fine-tuned",
    }
    (args.destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"downloaded": True, "model": manifest["model"], "sha256": SHA256, "directory": str(args.destination)}))


if __name__ == "__main__":
    main()
