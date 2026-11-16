"""Fetch only pinned Linux CPython 3.11 torch 2.6 / CUDA 12.4 wheels.

Official PyPI release metadata supplies wheel URLs, sizes and SHA-256 checksums.
Range requests run concurrently; completed parts are resumable. No install,
credentials, GPU use, environment mutation or interruption of an existing pip.
CPU/Python dependencies are listed separately and are not downloaded here.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
import urllib.parse
import urllib.request


PINNED = {
    "torch": "2.6.0", "triton": "3.2.0",
    "nvidia-cuda-nvrtc-cu12": "12.4.127", "nvidia-cuda-runtime-cu12": "12.4.127",
    "nvidia-cuda-cupti-cu12": "12.4.127", "nvidia-cudnn-cu12": "9.1.0.70",
    "nvidia-cublas-cu12": "12.4.5.8", "nvidia-cufft-cu12": "11.2.1.3",
    "nvidia-curand-cu12": "10.3.5.147", "nvidia-cusolver-cu12": "11.6.1.9",
    "nvidia-cusparse-cu12": "12.3.1.170", "nvidia-cusparselt-cu12": "0.6.2",
    "nvidia-nccl-cu12": "2.21.5", "nvidia-nvtx-cu12": "12.4.127",
    "nvidia-nvjitlink-cu12": "12.4.127",
}


def emit(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def metadata(name, version):
    url = "https://pypi.org/pypi/%s/%s/json" % (name, version)
    with urllib.request.urlopen(url, timeout=40) as response:
        result = json.load(response)
    matches = []
    for item in result["urls"]:
        filename = item["filename"]
        if not filename.endswith(".whl") or "linux" not in filename or "x86_64" not in filename:
            continue
        tags = filename[:-4].split("-")[-3:]
        if tags[0] not in ("cp311", "py3") or tags[1] not in ("cp311", "none"):
            continue
        matches.append(item)
    if len(matches) != 1:
        raise ValueError("Expected one Linux CPython 3.11 wheel for " + name)
    item = matches[0]
    return {"package": name, "version": version, "filename": item["filename"],
            "url": item["url"], "size": item["size"], "sha256": item["digests"]["sha256"],
            "metadata_url": url, "requires_dist": result["info"].get("requires_dist") or []}


def collect_manifest():
    with ThreadPoolExecutor(max_workers=6) as pool:
        wheels = list(pool.map(lambda item: metadata(*item), PINNED.items()))
    torch = next(item for item in wheels if item["package"] == "torch")
    gpu_dependencies = {}
    cpu_dependencies = []
    for requirement in torch["requires_dist"]:
        match = re.match(r"(nvidia-[a-z0-9-]+|triton)==([^; ]+)", requirement)
        if match:
            gpu_dependencies[match[1]] = match[2]
        elif "extra ==" not in requirement:
            cpu_dependencies.append(requirement)
    if gpu_dependencies != {name: version for name, version in PINNED.items() if name != "torch"}:
        raise ValueError("Official torch dependency set changed; review before downloading")
    return {"schema_version": 1, "target": "CPython 3.11 Linux x86_64, torch 2.6.0 CUDA 12.4",
            "provenance": "https://pypi.org/pypi/torch/2.6.0/json",
            "wheels": wheels, "total_bytes": sum(item["size"] for item in wheels),
            "cpu_python_dependencies_not_downloaded": cpu_dependencies,
            "installation_performed": False}


def validate_manifest(manifest):
    wheels = manifest.get("wheels")
    if not isinstance(wheels, list) or len(wheels) != len(PINNED):
        raise ValueError("Unexpected manifest wheel count")
    names = set()
    for item in wheels:
        name = item.get("package")
        url = urllib.parse.urlsplit(item.get("url", ""))
        filename = item.get("filename", "")
        if (name in names or PINNED.get(name) != item.get("version")
                or url.scheme != "https" or url.hostname != "files.pythonhosted.org"
                or url.username or url.password or url.query or url.fragment
                or not filename or Path(filename).name != filename or "/" in filename or "\\" in filename
                or not filename.endswith(".whl") or not url.path.endswith("/" + filename)
                or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", ""))
                or type(item.get("size")) is not int or not 0 < item["size"] < 2_000_000_000):
            raise ValueError("Invalid manifest item")
        names.add(name)
    total = sum(item["size"] for item in wheels)
    if names != set(PINNED) or total > 5_000_000_000 or manifest.get("total_bytes") != total:
        raise ValueError("Unexpected manifest packages or size")


def source_url(item, download_base):
    if not download_base:
        return item["url"]
    base = urllib.parse.urlsplit(download_base)
    if base.scheme != "https" or not base.hostname or base.username or base.password or base.query or base.fragment:
        raise ValueError("Download mirror must be an HTTPS base URL without credentials")
    # A mirror changes transport only: final wheel must match official PyPI SHA.
    return download_base.rstrip("/") + urllib.parse.urlsplit(item["url"]).path


def fetch_part(item, start, end, part, download_base):
    expected = end - start + 1
    if part.is_file() and part.stat().st_size == expected:
        return expected
    last = None
    for attempt in range(4):
        temporary = part.with_name(part.name + ".download")
        try:
            count = temporary.stat().st_size if temporary.is_file() else 0
            if count > expected:
                raise ValueError("Oversized partial file")
            if count == expected:
                temporary.replace(part)
                return expected
            request_start = start + count
            request = urllib.request.Request(source_url(item, download_base), headers={
                "Range": "bytes=%d-%d" % (request_start, end), "Accept-Encoding": "identity",
                "User-Agent": "Xim-Training-Wheel-Fetch/1.0",
            })
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206 or response.headers.get("Content-Range") != "bytes %d-%d/%d" % (request_start, end, item["size"]):
                    raise ValueError("Download source did not honor the exact byte range")
                with temporary.open("ab") as target:
                    while True:
                        block = response.read(min(1024 * 1024, expected - count + 1))
                        if not block:
                            break
                        count += len(block)
                        if count > expected:
                            raise ValueError("Unexpected range length")
                        target.write(block)
                if count != expected:
                    raise ValueError("Incomplete range")
            temporary.replace(part)
            return expected
        except Exception as error:
            last = error
            if attempt < 3:
                time.sleep(2 ** attempt)
    raise RuntimeError("Range download failed for %s at %d (%s)" % (item["filename"], start, type(last).__name__))


def assemble(item, parts, output):
    temporary = output / (item["filename"] + ".download")
    checksum = hashlib.sha256()
    count = 0
    with temporary.open("wb") as target:
        for part in parts:
            with part.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    checksum.update(block)
                    count += len(block)
                    target.write(block)
    if count != item["size"] or checksum.hexdigest() != item["sha256"]:
        temporary.unlink()
        raise ValueError("Official PyPI checksum mismatch; retained parts for inspection: " + item["filename"])
    temporary.replace(output / item["filename"])
    # Delete only the individually enumerated parts written for this wheel.
    for part in parts:
        part.unlink()
    emit(event="verified_download", filename=item["filename"], size=count, sha256=item["sha256"])


def download(manifest, output, concurrency, part_size, download_base):
    output = output.resolve()
    jobs = []
    parts_by_wheel = []
    for item in manifest["wheels"]:
        target = output / item["filename"]
        if target.is_file() and target.stat().st_size == item["size"] and digest(target) == item["sha256"]:
            emit(event="verified_existing", filename=item["filename"], size=item["size"])
            continue
        part_root = output / ".parts" / item["sha256"]
        part_root.mkdir(parents=True, exist_ok=True)
        parts = []
        for start in range(0, item["size"], part_size):
            end = min(start + part_size, item["size"]) - 1
            part = part_root / ("%012d-%012d.part" % (start, end))
            parts.append(part)
            jobs.append((item, start, end, part, download_base))
        parts_by_wheel.append((item, parts))
    # Parts plus one assembled wheel coexist temporarily. No pre-allocation.
    expected = sum(item["size"] for item, _ in parts_by_wheel)
    largest = max((item["size"] for item, _ in parts_by_wheel), default=0)
    if shutil.disk_usage(output).free < expected + largest + 512 * 1024 * 1024:
        raise ValueError("Insufficient disk space for resumable parts and final wheel")
    started = time.monotonic()
    completed_bytes = 0
    last_print = started
    groups = {item["sha256"]: (item, parts) for item, parts in parts_by_wheel}
    remaining = {key: len(parts) for key, (_, parts) in groups.items()}
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(fetch_part, *job): job[0]["sha256"] for job in jobs}
        for future in as_completed(futures):
            completed_bytes += future.result()
            key = futures[future]
            remaining[key] -= 1
            if remaining[key] == 0:
                # Make each verified wheel available immediately; torch need not
                # wait for the last NVIDIA dependency before it can be installed.
                item, parts = groups[key]
                assemble(item, parts, output)
            now = time.monotonic()
            if now - last_print >= 10:
                emit(event="download_progress", completed_bytes=completed_bytes, required_bytes=expected,
                     elapsed_seconds=round(now - started, 1), aggregate_mib_per_second=round(completed_bytes / max(0.001, now - started) / 1048576, 2),
                     rate_includes_resumed_bytes=True)
                last_print = now
    emit(event="completed", wheels=len(manifest["wheels"]), total_bytes=manifest["total_bytes"],
         elapsed_seconds=round(time.monotonic() - started, 1), installation_performed=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/training-wheels"))
    parser.add_argument("--manifest", type=Path, help="Reuse an existing official manifest, e.g. after transferring to the server")
    parser.add_argument("--manifest-only", action="store_true")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--part-mib", type=int, default=8)
    parser.add_argument("--download-base", help="Optional HTTPS mirror base, e.g. https://mirrors.aliyun.com/pypi")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or not 1 <= args.part_mib <= 32:
        parser.error("workers must be 1..32 and part-mib 1..32")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else collect_manifest()
    validate_manifest(manifest)
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output.resolve() / "manifest.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    emit(event="manifest_ready", manifest=str(target), wheels=len(manifest["wheels"]), total_bytes=manifest["total_bytes"],
         cpu_python_dependencies_not_downloaded=manifest["cpu_python_dependencies_not_downloaded"])
    if not args.manifest_only:
        download(manifest, args.output, args.workers, args.part_mib * 1024 * 1024, args.download_base)


if __name__ == "__main__":
    main()
