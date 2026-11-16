import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {getModelReply,ReplyError} from './model-reply.mjs';
import {emotions} from './policy.mjs';
import {VadSegmenter} from './voice-policy.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||8788);
let privateConfig={};
try {privateConfig=JSON.parse(await fs.readFile(process.env.XIM_CONFIG||path.join(os.homedir(),'AppData/Local/BandiPrivate/config.json'),'utf8'));}catch{}
const key=process.env.DEEPSEEK_API_KEY||privateConfig.api_key;
const model=process.env.DEEPSEEK_MODEL||'deepseek-flash';
const asrURL=process.env.ASR_URL||'http://127.0.0.1:8791';
const token=crypto.randomBytes(32).toString('hex'),replies=new Map(),rate=[];
let inflight=0;
const allowed=new Set(['127.0.0.1:'+port,'localhost:'+port]);
function trustedOrigin(origin){try{return ['http:','https:'].includes(new URL(origin).protocol)&&allowed.has(new URL(origin).host);}catch{return false;}}
const send=(r,s,data)=>{if(!r.destroyed){r.writeHead(s,{'Content-Type':'application/json','Cache-Control':'no-store'});r.end(JSON.stringify(data));}};
async function body(req){let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>32000)throw Error('limit');}return JSON.parse(b);}
const styles=JSON.parse(await fs.readFile(path.join(root,'evolution/active.json'),'utf8'));
const server=http.createServer(async(req,res)=>{
 try{
  if(!allowed.has(req.headers.host))return send(res,403,{error:'ACCESS_DENIED'});
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/api/bootstrap'){
    const asr=await fetch(asrURL+'/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).catch(()=>({ready:false}));
    return send(res,200,{token,configured:Boolean(key),model,emotions,asrReady:asr.ready===true,asrModel:asr.model||null,version:'0.6.1',policy:styles.id});
  }
  if(url.pathname.startsWith('/api/')){
    if(req.method!=='POST'||req.headers['x-bandi-token']!==token||!String(req.headers['content-type']).startsWith('application/json')||
       (req.headers.origin&&!trustedOrigin(req.headers.origin)))return send(res,403,{error:'ACCESS_DENIED'});
    const b=await body(req);
    if(url.pathname==='/api/chat'){
      if(typeof b.text!=='string'||!b.text.trim()||b.text.length>2000)return send(res,400,{error:'INVALID_INPUT'});
      if(!key)return send(res,503,{error:'MODEL_NOT_CONFIGURED'});
      const now=Date.now();while(rate.length&&rate[0]<now-60000)rate.shift();
      if(inflight>=2||rate.length>=20)return send(res,429,{error:'TOO_MANY_REQUESTS'});
      rate.push(now);inflight++;
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      try{
        const history=Array.isArray(b.history)?b.history.slice(-10).filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.content==='string'&&m.content.length<=2000):[];
        const result=await getModelReply({key,model,text:b.text,history,interruption:b.interruption,style:'warm',signal:controller.signal,policy:styles.instruction});
        const id=crypto.randomUUID();replies.set(id,{prompt:b.text,segments:result.segments,at:Date.now(),policy:styles.id});
        while(replies.size>100)replies.delete(replies.keys().next().value);
        return send(res,200,{id,segments:result.segments,model});
      }catch(e){return send(res,e instanceof ReplyError?e.status:502,{error:e.code||'MODEL_UNAVAILABLE'});}
      finally{clearTimeout(timeout);inflight--;}
    }
    if(url.pathname==='/api/feedback'){
      const entry=replies.get(b.id);
      if(!entry||Date.now()-entry.at>3600000||b.consent!==true||!['helpful','unhelpful'].includes(b.rating))return send(res,400,{error:'INVALID_FEEDBACK'});
      await fs.mkdir(path.join(root,'data'),{recursive:true});
      await fs.appendFile(path.join(root,'data/feedback.jsonl'),JSON.stringify({...entry,id:b.id,rating:b.rating,consent:true,source:'human_explicit_feedback'})+'\n');
      replies.delete(b.id);return send(res,200,{ok:true});
    }
    return send(res,404,{error:'NOT_FOUND'});
  }
  const assets=new Set(['index.html','app.js','dialogue-state.js','room.css','style.css','robot3d.js','voice-client.js','capture-worklet.js','vendor/three.module.js','vendor/three.core.js','media/xim-demo.mp4','media/poster.png']);
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!assets.has(name)||!['GET','HEAD'].includes(req.method))return send(res,404,{error:'NOT_FOUND'});
  const bytes=await fs.readFile(path.join(root,'public',name));
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.mp4':'video/mp4','.png':'image/png'}[path.extname(name)];
  const headers={'Content-Type':mime,'Cache-Control':'no-cache','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'"};
  if(mime==='video/mp4'){
    headers['Accept-Ranges']='bytes';
    if(req.headers.range&&req.method==='GET'){
      const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      const start=Number(range?.[1]),end=range?.[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
      if(!range||start>=bytes.length||start>end){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length});res.end();return;}
      res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));return;
    }
  }
  res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:bytes);
 }catch{send(res,400,{error:'BAD_REQUEST'});}
});
const wss=new WebSocketServer({noServer:true,maxPayload:12800,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/api/voice'||!allowed.has(req.headers.host)||!trustedOrigin(req.headers.origin)||wss.clients.size>=2){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
  let authorized=false,closed=false,last=Date.now(),current=null,seq=0;
  const output=data=>{if(ws.readyState===1)ws.send(JSON.stringify(data));};
  const vad=new VadSegmenter({onStart:()=>{seq++;current?.abort();output({type:'speech.start',seq});},onEnd:async pcm=>{
    const my=seq;current?.abort();const controller=new AbortController();current=controller;
    output({type:'speech.end',seq:my,durationMs:Math.round(pcm.length/32)});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
    try{
      let response;
      do {
        response=await fetch(asrURL+'/transcribe',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pcm,signal:controller.signal});
        if(response.status===429){await response.body?.cancel();await pause(150,undefined,{signal:controller.signal});}
      } while(response.status===429);
      if(!response.ok)throw Error('asr');
      const result=await response.json();
      if(!closed&&my===seq)output({type:'transcript',text:typeof result.text==='string'?result.text.slice(0,2000):'',reason:['no_match','low_confidence'].includes(result.reason)?result.reason:null,seq});
    }catch{if(!closed&&my===seq&&(!controller.signal.aborted||timedOut))output({type:'error',message:timedOut?'语音识别超时，请重试或使用文字对话。':'语音识别暂不可用，请使用文字对话。'});}
    finally{clearTimeout(timer);}
  }});
  const authTimer=setTimeout(()=>{if(!authorized)ws.close(1008,'Authentication required');},5000);
  const idle=setInterval(()=>{if(Date.now()-last>30000)ws.close(1000,'Idle');},10000);
  ws.on('message',(data,binary)=>{
    if(!authorized){
      try{const msg=JSON.parse(data);if(binary||msg.token!==token)throw Error();authorized=true;clearTimeout(authTimer);output({type:'ready'});}catch{ws.close(1008,'Authentication failed');}
      return;
    }
    last=Date.now();
    if(!binary){
      try{
        const message=JSON.parse(data);
        if(message.type==='speech.finish'){if(!vad.finish())output({type:'no_speech'});return;}
        if(message.type==='sensitivity'&&Number.isFinite(message.threshold)&&message.threshold>=.004&&message.threshold<=.04){vad.threshold=message.threshold;return;}
      }catch{}
      return ws.close(1008,'Invalid control');
    }
    if(data.length%2||data.length>6400)return ws.close(1008,'Invalid PCM');
    if(ws.bufferedAmount>128000)return ws.close(1013,'Slow connection');
    vad.push(data);
  });
  ws.on('close',()=>{closed=true;clearTimeout(authTimer);clearInterval(idle);current?.abort();vad.reset();});
  ws.on('error',()=>ws.close());
});
server.listen(port,'127.0.0.1',()=>console.log('Xim Duplex http://127.0.0.1:'+port));
