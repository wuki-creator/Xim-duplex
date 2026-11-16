import {WebSocket} from 'ws';

export const liveModel='moss-live-1.0';
const actions=new Set(['input.speech.started','input.speech.stopped','input.transcript.updated','input.transcript.done','input.transcript.revised','output.transcript.updated','output.transcript.done','response.audio.started','response.audio.done','response.audio.stop','response.ended','response.interrupted']);
const goodId=id=>typeof id==='string'&&id.length>0&&id.length<=256;
const pair=data=>goodId(data.run_id)&&goodId(data.turn_id);
const identity=d=>JSON.stringify([d.run_id,d.turn_id]);

export function connectLive({key,voice,instructions,send,fail,socketFactory=(url,options)=>new WebSocket(url,options)}){
  const upstream=socketFactory(`wss://api.mosi.cn/v1/realtime?model=${liveModel}`,{headers:{Authorization:`Bearer ${key}`},maxPayload:1048576,handshakeTimeout:8000,perMessageDeflate:false});
  const sampleRate=48000,runs=new Map();let closed=false,phase='opening',pending;
  const json=value=>{if(!closed&&upstream.readyState===1)upstream.send(JSON.stringify(value));};
  const close=()=>{if(!closed){closed=true;clearTimeout(timer);upstream.close();}};
  const error=()=>{if(closed)return;const started=phase==='ready';close();fail(started?'实时语音已断开。可重新连接，或切回基础语音。':'实时语音暂不可用。请检查模思权限，或选择基础语音。');};
  const timer=setTimeout(error,12000);
  const configure=()=>{
    phase='persona';
    json({action:'session.update',session:{persona:{name:'伴点',prompt:'你是伴点，温暖、尊重边界的中文桌面陪伴伙伴。像自然交谈一样有来有往。'},instructions,tools:[]}});
  };
  const register=d=>{
    const id=identity(d);
    if(!runs.has(id)){
      if(runs.size>=100)runs.delete(runs.keys().next().value);
      runs.set(id,{chunks:new Map(),seen:new Set(),done:false,stopping:false});
    }
    return runs.get(id);
  };
  upstream.on('open',()=>{phase='attach';json({action:'attach_session',memory_scope:'session'});});
  upstream.on('message',(frame,binary)=>{
    if(closed)return;
    if(binary){
      if(phase!=='ready')return;
      const d=pending;pending=null;
      if(!d||!frame.length||frame.length%2)return error();
      const run=runs.get(identity(d));if(!run||run.stopping||run.finalized||run.seen.has(d.chunk_id))return;
      if(run.chunks.size>=128||run.seen.size>=4096)return error();
      run.seen.add(d.chunk_id);
      run.chunks.set(d.chunk_id,frame.length*500/sampleRate);
      send({type:'live.chunk',data:{...d,sampleRate}});send(frame,true);
      return;
    }
    let event;try{event=JSON.parse(frame);}catch{return error();}
    const {action,data:d={}}=event;if(!d||typeof d!=='object')return;
    if(action==='error'||action==='session.closing')return error();
    if(phase==='attach'&&action==='session_attached'){
      if(voice){phase='voice';json({action:'change_voice',voice_name:voice});}else configure();
    }else if(phase==='voice'&&action==='voice_changed'){
      if(d.name!==voice)return error();configure();
    }else if(phase==='persona'&&action==='session.updated'){
      if(d.error!=='')return error();phase='media';
      json({action:'media.configure',output_audio:{format:'pcm16',sample_rate:sampleRate},input_audio:{format:'pcm16'},playback:'client'});
    }else if(phase==='media'&&action==='media.configured'){
      if(d.error||d.output_audio?.format!=='pcm16'||d.output_audio?.sample_rate!==sampleRate||d.output_audio?.channels!==1||d.input_audio?.format!=='pcm16'||d.playback!=='client')return error();
      phase='ready';clearTimeout(timer);json({action:'mic_state',enabled:true});send({type:'ready',mode:'live'});
    }else if(phase==='ready'){
      if(action==='response.audio.context'&&pair(d)&&goodId(d.chunk_id)){
        if(pending)return error();register(d);pending={run_id:d.run_id,turn_id:d.turn_id,chunk_id:d.chunk_id};
      }else if(actions.has(action)){
        const data={};
        if(pair(d)){
          data.run_id=d.run_id;data.turn_id=d.turn_id;
          if(action.startsWith('response.')){
            const run=register(d);
            if(action==='response.audio.done')run.done=true;
            if(action==='response.audio.stop'||action==='response.interrupted'||(action==='response.ended'&&d.status!=='completed'))run.stopping=true;
          }
        }else if(action.startsWith('response.')||action.startsWith('output.'))return;
        if(goodId(d.turn))data.turn=d.turn;
        if(typeof d.text==='string')data.text=d.text.slice(0,2400);
        if(['completed','aborted','failed'].includes(d.status))data.status=d.status;
        send({type:'live.event',action,data});
      }
    }
  });
  upstream.on('error',error);upstream.on('close',error);
  return {close,
    audio(pcm){if(!closed&&phase==='ready'&&upstream.readyState===1){if(upstream.bufferedAmount>64000)return error();upstream.send(pcm,{binary:true});}},
    playback(d){
      if(!d||!pair(d)||phase!=='ready')return;
      const run=runs.get(identity(d));if(!run||run.finalized)return;
      const info={run_id:d.run_id,turn_id:d.turn_id};
      if(d.action==='playback.chunk.completed'&&run.chunks.has(d.chunk_id)){
        run.chunks.delete(d.chunk_id);json({action:d.action,...info,chunk_id:d.chunk_id});
      }else if(d.action==='playback.completed'&&run.done&&!run.stopping&&run.chunks.size===0){
        run.finalized=true;json({action:d.action,...info});
      }else if(d.action==='playback.stopped'&&run.stopping){
        run.finalized=true;
        const head=run.chunks.values().next().value||0;
        const played=Number.isFinite(d.played_audio_ms)?Math.max(0,Math.min(head,d.played_audio_ms)):0;
        run.chunks.clear();json({action:d.action,...info,played_audio_ms:Math.floor(played)});
      }
    }
  };
}
