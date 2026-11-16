"""Loopback-only PCM16 ASR worker. Input: mono, 16 kHz, headerless little-endian PCM."""
import json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
engine=os.environ.get("ASR_ENGINE","whisper")
model_name="Windows zh-CN dictation" if engine=="windows" else os.environ.get("ASR_MODEL","tiny")
if engine=="windows":
    from windows_asr import WindowsASR
    native=WindowsASR()
else:
    import numpy as np
    from faster_whisper import WhisperModel
    model=WhisperModel(model_name,device=os.environ.get("ASR_DEVICE","cpu"),compute_type=os.environ.get("ASR_COMPUTE_TYPE","int8"))
lock=threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,status,obj):
        data=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(status);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.path!="/health": return self.send(404,{})
        self.send(200,{"ready":True,"model":model_name,"engine":engine})
    def do_POST(self):
        if self.path!="/transcribe": return self.send(404,{})
        try: length=int(self.headers.get("Content-Length",0))
        except ValueError: return self.send(400,{})
        if length<=0 or length>500000 or length%2: return self.send(400,{})
        if not lock.acquire(False): return self.send(429,{})
        try:
            raw=self.rfile.read(length)
            if len(raw)!=length: return self.send(400,{"error":"incomplete_pcm"})
            if engine=="windows":
                result=native.transcribe(raw)
            else:
                audio=np.frombuffer(raw,dtype="<i2").astype(np.float32)/32768
                segments,_=model.transcribe(audio,language="zh",beam_size=3,condition_on_previous_text=False,vad_filter=False)
                text="".join(s.text for s in segments if s.no_speech_prob<0.6).strip()
                result={"text":text,"reason":None if text else "no_match"}
            self.send(200,result)
        except Exception: self.send(503,{"error":"transcription_failed"})
        finally: lock.release()
ThreadingHTTPServer(("127.0.0.1",8791),Handler).serve_forever()
