import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {emotions} from './policy.mjs';
import {VadSegmenter} from './voice-policy.mjs';
import {interpretWorkbench,computeWorld,generateWorkbenchImage} from './workbench.mjs';
import {MeetingService,MeetingError} from './meeting.mjs';
import {localChat,localSpeech,loopbackUrl} from './local-models.mjs';
import {predictTurn,TurnReleaseGate} from './turn-completion.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||8788);
let asrConfig={};
try {asrConfig=JSON.parse(await fs.readFile(path.join(root,'private/asr.json'),'utf8'));}catch{}
const asrURL=process.env.ASR_URL||asrConfig.url||'http://127.0.0.1:8791';
let workbenchConfig={};
try{workbenchConfig=JSON.parse(await fs.readFile(path.join(root,'private/workbench.json'),'utf8'));}catch{}
const computeRemote=process.env.XIM_COMPUTE_URL||workbenchConfig.compute_url||'';
let localConfig={};try{localConfig=JSON.parse(await fs.readFile(path.join(root,'private/local-models.json'),'utf8'));}catch{}
const localChatUrl=process.env.XIM_LOCAL_CHAT_URL||localConfig.chat_url||'';
const localChatModel=process.env.XIM_LOCAL_CHAT_MODEL||localConfig.chat_model||'';
const localTtsUrl=process.env.XIM_LOCAL_TTS_URL||localConfig.tts_url||'';
const localVoice=process.env.XIM_LOCAL_VOICE||localConfig.tts_voice||'default';
const localTtsModel=process.env.XIM_LOCAL_TTS_MODEL||localConfig.tts_model||'';
const localImageUrl=process.env.XIM_LOCAL_IMAGE_URL||localConfig.image_url||'';
const localImageModel=process.env.XIM_LOCAL_IMAGE_MODEL||localConfig.image_model||'';
let turnConfig={};try{turnConfig=JSON.parse(await fs.readFile(path.join(root,'private/turn-model.json'),'utf8'));}catch{}
const turnUrl=process.env.XIM_TURN_URL??turnConfig.url??'';
for(const url of [asrURL,localChatUrl,localTtsUrl,localImageUrl,turnUrl].filter(Boolean))loopbackUrl(url,'/');
let workbenchBusy=0,imageBusy=false;
const meeting=new MeetingService({url:localChatUrl,model:localChatModel,remote:computeRemote});
const token=crypto.randomBytes(32).toString('hex'),replies=new Map(),rate=[];
const ttsRate=[];let inflight=0,ttsInflight=0;
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
    const health=url=>url?fetch(loopbackUrl(url,'/health'),{signal:AbortSignal.timeout(1000)}).then(r=>r.ok?r.json():{}).catch(()=>({ready:false})):Promise.resolve({});
    const [asr,chat,turn]=await Promise.all([health(asrURL),health(localChatUrl),health(turnUrl)]);
    return send(res,200,{token,configured:Boolean(localChatUrl&&localChatModel&&chat.ready===true),model:localChatModel||null,emotions,asrReady:asr.ready===true,asrModel:asr.model||null,turnReady:turn.ready===true,turnModel:turn.ready===true?turn.model:null,voiceLive:false,voiceMode:'cascade',voiceEngine:'xim-cascade',cloudAsr:false,serverTts:Boolean(localTtsUrl&&localTtsModel),speechChunkLength:localTtsModel==='xim-moss-nano'?14:72,imageReady:Boolean(localImageUrl&&localImageModel),version:'0.9.3',policy:styles.id});
  }
  if(url.pathname.startsWith('/api/')){
    if(req.method!=='POST'||req.headers['x-bandi-token']!==token||!String(req.headers['content-type']).startsWith('application/json')||
       (req.headers.origin&&!trustedOrigin(req.headers.origin)))return send(res,403,{error:'ACCESS_DENIED'});
    const b=await body(req);
    if(url.pathname.startsWith('/api/meeting/')){
      if(!b||typeof b!=='object')return send(res,400,{error:'INVALID_INPUT'});
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
      try{
        if(url.pathname==='/api/meeting/create')return send(res,200,meeting.create());
        if(url.pathname==='/api/meeting/input')return send(res,200,await meeting.input(b.id,b.text,b.selected,signal));
        if(url.pathname==='/api/meeting/approve')return send(res,200,await meeting.approve(b.id,b.task,b.rev,signal));
        return send(res,404,{error:'NOT_FOUND'});
      }catch(e){return send(res,e instanceof MeetingError?e.status:502,{error:e instanceof MeetingError?e.code:'MEETING_UNAVAILABLE',message:e instanceof MeetingError?e.message:'暂时无法处理这场会议。'});}
    }
    if(url.pathname==='/api/workbench/intent'){
      if(!localChatUrl||!localChatModel)return send(res,503,{error:'MODEL_NOT_CONFIGURED'});
      if(typeof b.input!=='string'||!b.input.trim()||b.input.length>1000)return send(res,400,{error:'INVALID_INPUT'});
      if(workbenchBusy>=3)return send(res,429,{error:'BUSY'});
      workbenchBusy++;const controller=new AbortController();res.on('close',()=>controller.abort());
      try{return send(res,200,await interpretWorkbench({url:localChatUrl,model:localChatModel,input:b.input,context:b.context,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])}));}
      catch{return send(res,502,{error:'MODEL_UNAVAILABLE'});}finally{workbenchBusy--;}
    }
    if(url.pathname==='/api/workbench/compute'){
      if(workbenchBusy>=3)return send(res,429,{error:'BUSY'});
      workbenchBusy++;const controller=new AbortController();res.on('close',()=>controller.abort());
      try{
        const result=await computeWorld(b,{remote:computeRemote,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(9000)])});
        return send(res,result.error?400:200,result);
      }catch{return send(res,502,{error:'COMPUTE_UNAVAILABLE'});}finally{workbenchBusy--;}
    }
    if(url.pathname==='/api/workbench/image'){
      if(!localImageUrl||!localImageModel)return send(res,503,{error:'IMAGE_NOT_CONFIGURED'});
      if(b.confirmed!==true||typeof b.prompt!=='string'||!b.prompt.trim()||b.prompt.length>700)return send(res,400,{error:'INVALID_INPUT'});
      if(imageBusy)return send(res,429,{error:'BUSY'});
      imageBusy=true;const controller=new AbortController();res.on('close',()=>controller.abort());
      try{return send(res,200,await generateWorkbenchImage({url:localImageUrl,model:localImageModel,prompt:b.prompt,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])}));}
      catch(e){return send(res,502,{error:['IMAGE_BALANCE','IMAGE_FORBIDDEN'].includes(e.message)?e.message:'IMAGE_UNAVAILABLE'});}finally{imageBusy=false;}
    }
    if(url.pathname==='/api/chat'){
      if(typeof b.text!=='string'||!b.text.trim()||b.text.length>2000)return send(res,400,{error:'INVALID_INPUT'});
      if(!localChatUrl||!localChatModel)return send(res,503,{error:'MODEL_NOT_CONFIGURED'});
      const now=Date.now();while(rate.length&&rate[0]<now-60000)rate.shift();
      if(inflight>=2||rate.length>=20)return send(res,429,{error:'TOO_MANY_REQUESTS'});
      rate.push(now);inflight++;
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      try{
        const history=Array.isArray(b.history)?b.history.slice(-10).filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.content==='string'&&m.content.length<=2000):[];
        const result=await localChat({url:localChatUrl,model:localChatModel,text:b.text,history,interruption:b.interruption,styleInstruction:styles.instruction,signal:controller.signal});
        const id=crypto.randomUUID();replies.set(id,{prompt:b.text,segments:result.segments,at:Date.now(),policy:styles.id});
        while(replies.size>100)replies.delete(replies.keys().next().value);
        return send(res,200,{id,segments:result.segments,model:localChatModel});
      }catch{return send(res,502,{error:'MODEL_UNAVAILABLE'});}
      finally{clearTimeout(timeout);inflight--;}
    }
    if(url.pathname==='/api/speech'){
      if(!localTtsUrl||!localTtsModel)return send(res,503,{error:'SPEECH_NOT_CONFIGURED'});
      const entry=replies.get(b.id);
      const text=entry&&Number.isInteger(b.offset)&&Number.isInteger(b.end)?entry.segments.map(s=>s.text).join('\n').slice(b.offset,b.end):'';
      if(!text.trim()||b.offset<0||b.end-b.offset>90)return send(res,400,{error:'INVALID_INPUT'});
      const now=Date.now();while(ttsRate.length&&ttsRate[0]<now-60000)ttsRate.shift();
      if(ttsInflight>=2||ttsRate.length>=50)return send(res,429,{error:'TOO_MANY_REQUESTS'});
      ttsInflight++;ttsRate.push(now);
      const controller=new AbortController();res.on('close',()=>controller.abort());
      try{
        const speechSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
        let cursor=0,emotion='warm';
        for(const segment of entry.segments){const end=cursor+segment.text.length;if(b.offset<end){emotion=segment.emotion;break;}cursor=end+1;}
        const wav=await localSpeech({url:localTtsUrl,model:localTtsModel,text,voice:localVoice,emotion,signal:speechSignal});
        if(!res.destroyed){res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length,'Cache-Control':'no-store'});res.end(wav);}
      }catch{return send(res,502,{error:'SPEECH_UNAVAILABLE'});}finally{ttsInflight--;}
      return;
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
  const assets=new Set(['index.html','app.js','speech-queue.js','dialogue-state.js','room.css','style.css','robot3d.js','voice-client.js','capture-worklet.js','workbench.html','workbench.css','workbench.js','world.js','meeting.html','meeting.css','meeting-ui.js','vendor/cannon-es.js','vendor/three.module.js','vendor/three.core.js','media/xim-demo.mp4','media/poster.png']);
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!assets.has(name)||!['GET','HEAD'].includes(req.method))return send(res,404,{error:'NOT_FOUND'});
  const bytes=await fs.readFile(name==='vendor/cannon-es.js'?path.join(root,'node_modules/cannon-es/dist/cannon-es.js'):path.join(root,'public',name));
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.mp4':'video/mp4','.png':'image/png'}[path.extname(name)];
  const images=name==='workbench.html'?' https:':'';
  const headers={'Content-Type':mime,'Cache-Control':'no-cache','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:${images}; frame-ancestors 'none'`};
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
  const pendingAudio=[],recognized=[];let recognizing=false,forceRelease=false;
  const gate=new TurnReleaseGate({canRelease:()=>!closed&&!recognizing&&!vad.active&&!pendingAudio.length&&recognized.length>0,onRelease:()=>{
    const missed=recognized.find(item=>!item.text.trim());
    output({type:'transcript',text:missed?'':recognized.map(item=>item.text).join(' ').slice(0,2000),reason:missed?.reason||null,seq});
    recognized.length=0;forceRelease=false;
  }});
  const vad=new VadSegmenter({onStart:()=>{gate.cancel();forceRelease=false;seq++;output({type:'speech.start',seq});},onEnd:pcm=>{
    output({type:'speech.end',seq,durationMs:Math.round(pcm.length/32)});
    if(pendingAudio.length>=3){output({type:'error',message:'识别暂时跟不上，请稍后重连或使用文字。'});ws.close(1013,'Recognition backlog');return;}
    pendingAudio.push({pcm,forced:forceRelease});void transcribePending();
  }});
  async function transcribePending(){
   if(recognizing||closed)return;
   recognizing=true;let failed=false;
   while(pendingAudio.length&&!closed){
    const {pcm,forced}=pendingAudio.shift(),controller=new AbortController();current=controller;
    // Run acoustic turn prediction alongside ASR, not as a second LLM call.
    const boundary=forced?Promise.resolve(null):predictTurn({url:turnUrl,pcm,signal:controller.signal});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
    try{
      let response;
      let result;
      if(!result){
        do {
          response=await fetch(asrURL+'/transcribe',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pcm,signal:controller.signal});
          if(response.status===429){await response.body?.cancel();await pause(150,undefined,{signal:controller.signal});}
        } while(response.status===429);
        if(!response.ok)throw Error('asr');
        result=await response.json();
      }
      const turn=await boundary;
      if(!closed)recognized.push({text:typeof result.text==='string'?result.text.slice(0,2000):'',complete:forced?true:turn?.complete,reason:['no_match','low_confidence','overlap'].includes(result.reason)?result.reason:'no_match'});
    }catch{
      failed=true;gate.cancel();pendingAudio.length=0;recognized.length=0;
      if(!closed&&(!controller.signal.aborted||timedOut))output({type:'error',message:timedOut?'语音识别超时，请重试或使用文字对话。':'语音识别暂不可用，请使用文字对话。'});
      break;
    }
    finally{clearTimeout(timer);}
   }
   recognizing=false;
   // A short hesitation can join the next utterance; silence is bounded to avoid a stuck conversation.
   if(!failed)gate.update(forceRelease||recognized.some(item=>!item.text.trim())?true:recognized.at(-1)?.complete);
  }
  const authTimer=setTimeout(()=>{if(!authorized)ws.close(1008,'Authentication required');},5000);
  const idle=setInterval(()=>{if(Date.now()-last>30000)ws.close(1000,'Idle');},10000);
  ws.on('message',(data,binary)=>{
    if(!authorized){
      try{
        if(binary)throw Error();
        const msg=JSON.parse(data);if(msg.token!==token)throw Error();authorized=true;clearTimeout(authTimer);
        // Old cached clients must refresh; never silently connect a retired provider.
        if(msg.mode==='live'){output({type:'error',message:'语音引擎已更新，请刷新页面后重新开启。'});ws.close(1008,'Refresh required');return;}
        output({type:'ready',mode:'cascade',engine:'xim-cascade'});
      }catch{ws.close(1008,'Authentication failed');}
      return;
    }
    last=Date.now();
    if(!binary){
      try{
        const message=JSON.parse(data);
        if(message.type==='speech.finish'){forceRelease=true;gate.cancel();if(!vad.finish()){if(recognized.length)gate.update(true);else if(!recognizing)output({type:'no_speech'});}return;}
        if(message.type==='sensitivity'&&Number.isFinite(message.threshold)&&message.threshold>=.004&&message.threshold<=.04){vad.threshold=message.threshold;return;}
      }catch{}
      return ws.close(1008,'Invalid control');
    }
    if(data.length%2||data.length>6400)return ws.close(1008,'Invalid PCM');
    if(ws.bufferedAmount>128000)return ws.close(1013,'Slow connection');
    vad.push(data);
  });
  ws.on('close',()=>{closed=true;gate.cancel();clearTimeout(authTimer);clearInterval(idle);current?.abort();vad.reset();});
  ws.on('error',()=>ws.close());
});
server.listen(port,'127.0.0.1',()=>console.log('Xim Duplex http://127.0.0.1:'+port));
