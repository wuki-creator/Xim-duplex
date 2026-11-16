"""Fetch a small pinned public-data development sample, not a training set."""
import argparse,concurrent.futures,json,urllib.parse,urllib.request
from pathlib import Path

REV='e1c7e4f38ef3fdd1b35b44066b53eb05498f458d'
BASE='https://huggingface.co/datasets/AISHELL/AISHELL-3/resolve/'+REV+'/'
TREE='https://huggingface.co/api/datasets/AISHELL/AISHELL-3/tree/'+REV+'/'
SPEAKERS=['SSB0005','SSB0009','SSB0011']

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--per-speaker',type=int,default=10);a=p.parse_args()
    if not 1<=a.per_speaker<=50:p.error('per-speaker must be between 1 and 50')
    root=a.output.resolve();root.mkdir(parents=True,exist_ok=True)
    paths=['train/content.txt']
    for speaker in SPEAKERS:
        with urllib.request.urlopen(TREE+'train/wav/'+speaker+'?limit=100',timeout=45) as response:entries=json.load(response)
        paths.extend(sorted(v['path'] for v in entries if v.get('type')=='file' and v['path'].endswith('.wav'))[:a.per_speaker])
    def download(path):
        target=(root/path).resolve()
        if root not in target.parents:raise ValueError('invalid path')
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():
            with urllib.request.urlopen(BASE+urllib.parse.quote(path),timeout=60) as response:
                data=response.read(12_000_001)
            if len(data)>12_000_000:raise ValueError('unexpected source size')
            target.write_bytes(data)
        return target.stat().st_size
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:sizes=list(pool.map(download,paths))
    print(json.dumps({'dataset':'AISHELL/AISHELL-3','revision':REV,'speakers':SPEAKERS,'files':len(paths)-1,'bytes':sum(sizes)}))
if __name__=='__main__':main()
