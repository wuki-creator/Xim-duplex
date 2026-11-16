"""Download the pinned Qwen3-8B base; verify every weight against upstream SHA-256.

Only downloads assets. Does not execute repository code or allocate a GPU.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import time
import urllib.request

REPO = 'Qwen/Qwen3-8B'
REVISION = 'b968826d9c46dd6066d109eabc6255188de91218'


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(8 * 1024 * 1024):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.workers <= 48:
        parser.error('workers must be 1-48')
    args.destination.mkdir(parents=True, exist_ok=True)
    api = f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true'
    with urllib.request.urlopen(api, timeout=40) as response:
        metadata = json.load(response)
    if metadata['sha'] != REVISION:
        raise ValueError('revision_mismatch')
    files = [item for item in metadata['siblings'] if '/' not in item['rfilename'] and (item['rfilename'].endswith(('.json', '.safetensors', '.txt')) or item['rfilename'] in ('LICENSE', 'README.md'))]
    required = sum(item['size'] for item in files if not (args.destination / item['rfilename']).exists())
    if shutil.disk_usage(args.destination).free < required + 1024 ** 3:
        raise RuntimeError('insufficient_disk_space')
    manifest = {'repo':REPO, 'revision':REVISION, 'parameters':8190735360, 'license':'Apache-2.0', 'files':[]}
    for item in files:
        name, size = item['rfilename'], item['size']
        destination = args.destination / name
        expected = item.get('lfs', {}).get('sha256')
        if destination.is_file() and destination.stat().st_size == size and (not expected or digest(destination) == expected):
            print('verified existing', name, flush=True)
        else:
            temporary = destination.with_suffix(destination.suffix + '.part')
            with temporary.open('wb') as output:
                output.truncate(size)
            url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}'
            chunk = 64 * 1024 * 1024
            ranges = [(start, min(size - 1, start + chunk - 1)) for start in range(0, size, chunk)]
            def fetch_range(bounds):
                start, end = bounds
                for attempt in range(5):
                    try:
                        request = urllib.request.Request(url + f'?download=true&xim_range={start}', headers={'Range':f'bytes={start}-{end}'})
                        with urllib.request.urlopen(request, timeout=60) as source, temporary.open('r+b') as output:
                            if len(ranges) > 1 and (source.status != 206 or source.headers.get('Content-Range') != f'bytes {start}-{end}/{size}'):
                                raise ValueError('invalid_content_range')
                            output.seek(start)
                            remaining = end - start + 1
                            while remaining:
                                block = source.read(min(1024 * 1024, remaining))
                                if not block:
                                    raise ValueError('incomplete_download')
                                output.write(block)
                                remaining -= len(block)
                        return end - start + 1
                    except Exception as error:
                        if attempt == 4:
                            raise
                        print('retry', name, start, type(error).__name__, flush=True)
                        time.sleep(1 + attempt)
            total = 0
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                for finished in as_completed([pool.submit(fetch_range, bounds) for bounds in ranges]):
                    count = finished.result()
                    total += count
                    if len(ranges) > 1:
                        print(name, f'{total / size:.0%}', flush=True)
            actual = digest(temporary)
            if expected and actual != expected:
                raise ValueError('weight_checksum_mismatch:' + name)
            temporary.replace(destination)
            print('verified', name, flush=True)
        manifest['files'].append({'name':name, 'size':size, 'sha256':digest(destination)})
        (args.destination / 'download-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('all model assets verified', flush=True)


if __name__ == '__main__':
    main()
