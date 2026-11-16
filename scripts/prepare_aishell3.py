"""Prepare a reproducible, speaker-isolated AISHELL-3 manifest for Nano SFT.

Uses the official extracted train/content.txt and train/wav/<speaker>/<id>.wav.
No audio is copied; source paths and checksums are recorded for auditing.
"""
import argparse, hashlib, json, re, wave
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--eval-speakers',type=int,default=2)
    parser.add_argument('--limit',type=int,default=0)
    args=parser.parse_args()
    root=args.root.resolve();wav=root/'train'/'wav';content=root/'train'/'content.txt'
    if not content.is_file() or not wav.is_dir():parser.error('Expected train/content.txt and train/wav directories')
    if args.eval_speakers<1:parser.error('eval-speakers must be positive')
    rows=[];skipped=0
    available={p.stem.upper():p for p in wav.glob('SSB*/*.wav') if p.is_file()}
    for line in content.read_text(encoding='utf-8-sig').splitlines():
        bits=line.split();
        if len(bits)<2:continue
        uid=bits[0][:-4] if bits[0].lower().endswith('.wav') else bits[0]
        if not re.fullmatch(r'SSB\d{8}',uid,re.I):skipped+=1;continue
        speaker=uid[:7];candidate=available.get(uid.upper())
        if candidate is None:skipped+=1;continue
        path=candidate.resolve()
        if root not in path.parents or not path.is_file():skipped+=1;continue
        # AISHELL-3 content alternates Hanzi and pinyin with tone numbers.
        sentence=''.join(''.join(re.findall(r'[\u3400-\u9fff，。！？；：、]',token)) for token in bits[1:])
        if not sentence:skipped+=1;continue
        try:
            with wave.open(str(path),'rb') as audio:
                duration=audio.getnframes()/audio.getframerate()
                if audio.getnchannels()!=1 or audio.getsampwidth()!=2 or not .4<=duration<=20:skipped+=1;continue
        except (wave.Error,EOFError,ZeroDivisionError):skipped+=1;continue
        rows.append({'audio':str(path),'text':sentence,'language':'zh','speaker':speaker,'duration':round(duration,3),'id':uid})
        if args.limit and len(rows)>=args.limit:break
    speakers=sorted({r['speaker'] for r in rows},key=lambda s:hashlib.sha256(('xim-aishell3-v1:'+s).encode()).hexdigest())
    if len(speakers)<=args.eval_speakers:parser.error('Not enough speakers for an independent holdout')
    held=set(speakers[:args.eval_speakers]);args.output.mkdir(parents=True,exist_ok=True)
    manifests={'train':[],'holdout':[]}
    for row in rows:manifests['holdout' if row['speaker'] in held else 'train'].append(row)
    for split,items in manifests.items():
        with (args.output/(split+'_raw.jsonl')).open('w',encoding='utf-8') as out:
            for row in items:out.write(json.dumps({k:row[k] for k in ('audio','text','language')},ensure_ascii=False)+'\n')
    report={'source':'AISHELL/AISHELL-3','upstream_license':'Apache-2.0 (dataset card)','manifest_sha256':hashlib.sha256(content.read_bytes()).hexdigest(),'train_rows':len(manifests['train']),'holdout_rows':len(manifests['holdout']),'train_speakers':len(speakers)-len(held),'holdout_speakers':sorted(held),'skipped':skipped,'note':'Neutral speech; inspect audio rights, source attribution and speaker consent before commercial voice identity or cloning.'}
    (args.output/'dataset_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':main()
