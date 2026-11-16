"""Xim local speech service using pinned OpenMOSS Nano weights and runtime.

Starts on loopback only. A local reference WAV must be supplied by the operator;
requests cannot select files or clone arbitrary voices. Optional adapter must be a
reviewed safetensors checkpoint. No adapter is trained or enabled by default.
"""
import argparse
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--upstream',required=True)
parser.add_argument('--checkpoint',required=True)
parser.add_argument('--codec',required=True)
parser.add_argument('--reference-wav',required=True)
parser.add_argument('--temporary-dir',required=True)
parser.add_argument('--adapter',default='')
parser.add_argument('--adapter-rank',type=int,default=32)
parser.add_argument('--device',default='cpu')
parser.add_argument('--port',type=int,default=18799)
args=parser.parse_args()
upstream=Path(args.upstream).resolve();reference=Path(args.reference_wav).resolve()
if not reference.is_file() or reference.suffix.lower()!='.wav':raise SystemExit('An authorized reference WAV is required')
temp_root=Path(args.temporary_dir).resolve();temp_root.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(upstream));sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'training'))
import torch
from moss_tts_nano_runtime import NanoTTSService,VoicePreset
from xim_moss_adapter import XimAffectAdapter,STYLES,attach_adapter

runtime=NanoTTSService(checkpoint_path=args.checkpoint,audio_tokenizer_path=args.codec,
    device=args.device,attn_implementation='sdpa',output_dir=temp_root,
    voice_presets={'xim':VoicePreset('xim',reference,'operator supplied reference')})
model=runtime.get_model()
with runtime._lock:runtime._load_audio_tokenizer_locked(tts_attn_implementation='sdpa')
lock=threading.Lock();active_style='warm';adapter_enabled=False
if args.adapter:
    from safetensors.torch import load_file
    size=int(model.config.gpt2_config.n_embd)
    adapter=XimAffectAdapter(size,args.adapter_rank)
    adapter.load_state_dict(load_file(str(Path(args.adapter).resolve()),device='cpu'),strict=True)
    adapter.to(device=runtime.device,dtype=runtime.dtype).eval()
    attach_adapter(model,adapter,lambda:active_style);adapter_enabled=True

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def reply(self,status,payload):
        data=json.dumps(payload,ensure_ascii=False).encode('utf-8')
        self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.path=='/health':return self.reply(200,{'ready':True,'model':'xim-moss-nano','adapter':adapter_enabled})
        self.reply(404,{'error':'not_found'})
    def do_POST(self):
        global active_style
        if self.path!='/v1/audio/speech':return self.reply(404,{'error':'not_found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<1 or length>8192:raise ValueError('invalid body')
            data=json.loads(self.rfile.read(length));text=data.get('input');style=data.get('emotion','warm')
            if data.get('model')!='xim-moss-nano' or data.get('voice')!='xim' or data.get('response_format')!='wav':raise ValueError('invalid config')
            if not isinstance(text,str) or not text.strip() or len(text)>90 or style not in STYLES:raise ValueError('invalid text')
            if not lock.acquire(timeout=25):return self.reply(503,{'error':'busy'})
            try:
                active_style=style
                with tempfile.TemporaryDirectory(prefix='xim-speech-',dir=temp_root) as tmp:
                    output=Path(tmp)/'speech.wav'
                    with torch.inference_mode():runtime.synthesize(text=text,voice='xim',mode='voice_clone',output_audio_path=output,max_new_frames=90,do_sample=True)
                    wav=output.read_bytes()
                if not 44<=len(wav)<=4000000 or wav[:4]!=b'RIFF' or wav[8:12]!=b'WAVE':
                    print('invalid_waveform_bytes:',len(wav),'header:',repr(wav[:12]),flush=True)
                    raise ValueError('invalid waveform')
            finally:lock.release()
            self.send_response(200);self.send_header('Content-Type','audio/wav')
            self.send_header('Content-Length',str(len(wav)));self.end_headers();self.wfile.write(wav)
        except (ValueError,TypeError,KeyError,json.JSONDecodeError) as e:
            print('invalid_or_synthesis:',type(e).__name__,flush=True)
            self.reply(400,{'error':'invalid_input'})
        except Exception as e:
            print('speech_failed:',type(e).__name__,flush=True)
            self.reply(500,{'error':'speech_failed'})

ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
