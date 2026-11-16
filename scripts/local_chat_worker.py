"""Single-GPU, loopback-only Qwen worker. Model weights are never fetched at runtime."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
parser.add_argument('--model-name', default='Qwen2.5-1.5B-Instruct')
parser.add_argument('--port', type=int, default=18797)
args = parser.parse_args()
tokenizer = AutoTokenizer.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False)
model = AutoModelForCausalLM.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False, torch_dtype=torch.float16).to('cuda').eval()
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass  # Prompts and replies are not written to logs.
    def send_json(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded))); self.end_headers(); self.wfile.write(encoded)
    def do_GET(self):
        if self.path == '/health': self.send_json(200, {'ready': True, 'model': args.model_name})
        else: self.send_json(404, {'error': 'not_found'})
    def do_POST(self):
        if self.path != '/v1/chat/completions': return self.send_json(404, {'error':'not_found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<1 or length>64000: raise ValueError('body')
            data=json.loads(self.rfile.read(length)); messages=data['messages']
            if data.get('model')!=args.model_name or not isinstance(messages,list) or not 1<=len(messages)<=14: raise ValueError('model or messages')
            if any(not isinstance(m,dict) or m.get('role') not in ('system','user','assistant') or not isinstance(m.get('content'),str) or len(m['content'])>12000 for m in messages): raise ValueError('messages')
            limit=min(1200,max(1,int(data.get('max_tokens',400))))
            if not lock.acquire(timeout=30): return self.send_json(503,{'error':'busy'})
            try:
                prompt=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True)
                inputs=tokenizer(prompt,return_tensors='pt').to('cuda')
                with torch.inference_mode():
                    output=model.generate(**inputs,max_new_tokens=limit,do_sample=False,pad_token_id=tokenizer.eos_token_id)
                new=output[0][inputs.input_ids.shape[1]:]
                content=tokenizer.decode(new,skip_special_tokens=True).strip()
                stopped=len(new)<limit or (len(new)>0 and int(new[-1])==tokenizer.eos_token_id)
            finally: lock.release()
            self.send_json(200,{'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop' if stopped else 'length'}]})
        except (ValueError,TypeError,KeyError,json.JSONDecodeError): self.send_json(400,{'error':'invalid_input'})
        except Exception as error:
            print('inference_failed:',type(error).__name__,flush=True)
            self.send_json(500,{'error':'inference_failed'})

ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
