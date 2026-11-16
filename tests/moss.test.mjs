import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {connectLive} from '../moss-live.mjs';
import {pcmWav,synthesizeMoss,transcribeMoss} from '../moss-models.mjs';
import {getModelReply} from '../model-reply.mjs';
import {LivePlayer} from '../public/live-player.js';

test('live relays microphone audio only after setup and acknowledges known playback', t=>{
  const sent=[],client=[],upstream=new EventEmitter();
  upstream.readyState=1;upstream.send=(value,options)=>sent.push(options?.binary?value:JSON.parse(value));
  upstream.close=()=>{upstream.readyState=3;};
  const bridge=connectLive({key:'mock',voice:'voice-id',instructions:'测试',send:(x,binary)=>client.push({x,binary}),fail:assert.fail,socketFactory:(url,options)=>{
    assert.equal(url,'wss://api.mosi.cn/v1/realtime?model=moss-live-1.0');
    assert.equal(options.headers.Authorization,'Bearer mock');return upstream;
  }});
  t.after(bridge.close);
  const receive=(action,data)=>upstream.emit('message',Buffer.from(JSON.stringify({action,data})),false);
  const audio=Buffer.alloc(9600),turn={run_id:'r1',turn_id:'t1'};
  upstream.emit('open');bridge.audio(audio);assert.equal(sent.length,1);
  receive('session_attached',{});receive('voice_changed',{name:'voice-id'});receive('session.updated',{error:''});
  assert.deepEqual(sent.map(x=>x.action),['attach_session','change_voice','session.update','media.configure']);
  receive('media.configured',{error:'',input_audio:{format:'pcm16'},output_audio:{format:'pcm16',channels:1,sample_rate:48000},playback:'client'});
  assert.equal(client[0].x.mode,'live');bridge.audio(audio);assert.equal(sent.at(-1),audio);
  receive('input.transcript.updated',{text:'不是工作'});receive('input.transcript.done',{turn:'u1',text:'不是工作，是家里的事'});
  const pushChunk=chunk_id=>{receive('response.audio.context',{...turn,chunk_id});upstream.emit('message',audio,true);};
  pushChunk('c1');pushChunk('c2');
  bridge.playback({action:'playback.chunk.completed',...turn,chunk_id:'fake'});assert.equal(sent.at(-1),audio);
  bridge.playback({action:'playback.chunk.completed',...turn,chunk_id:'c1'});
  pushChunk('c1');assert.equal(client.filter(x=>x.binary).length,2);
  receive('response.audio.stop',turn);
  bridge.playback({action:'playback.stopped',...turn,played_audio_ms:9000});
  assert.deepEqual(sent.at(-1),{action:'playback.stopped',...turn,played_audio_ms:100});
  pushChunk('late');assert.equal(client.filter(x=>x.binary).length,2);
  assert.deepEqual(client.filter(x=>x.x.action?.startsWith('input.transcript')).map(x=>x.x.data.text),['不是工作','不是工作，是家里的事']);
});

test('browser playback waits for its output clock and drops queued chunks on interruption', t=>{
  const acks=[],sources=[];let output=.001;
  const context={currentTime:1,destination:{},getOutputTimestamp:()=>({contextTime:output,performanceTime:1}),createGain:()=>({connect(){},disconnect(){}}),createBuffer:(channels,n,hz)=>({duration:n/hz,getChannelData:()=>new Float32Array(n)}),createBufferSource:()=>{
    const source={start(){},stop(){this.stopped=true;},connect(){},disconnect(){}};sources.push(source);return source;
  }};
  const player=new LivePlayer(context,value=>acks.push(value));t.after(()=>player.close());
  const ids={run_id:'r',turn_id:'t'};
  for(const chunk_id of ['1','2','3']){player.pending={...ids,chunk_id,sampleRate:48000};player.speakFrame(new ArrayBuffer(9600));}
  player.event('response.audio.done',ids);player.confirm();assert.equal(acks.length,0);
  context.currentTime=1.23;output=1.197;
  player.event('response.audio.stop',ids);
  assert.deepEqual(acks.map(({action,chunk_id})=>[action,chunk_id]),[['playback.chunk.completed','1'],['playback.stopped',undefined]]);
  assert.equal(acks[1].played_audio_ms,42);
  assert.ok(sources[1].stopped&&sources[2].stopped);
  player.event('response.interrupted',ids);player.confirm(10);assert.equal(acks.length,2);
});

test('MOSS multipart ASR keeps anonymous multi-speaker responses out of conversation',async()=>{
  const pcm=Buffer.from([1,2,3,4]);
  const output=await transcribeMoss({key:'mock',model:'moss-transcribe-diarize-pro',pcm,request:async(url,{body})=>{
    assert.equal(new URL(url).pathname,'/v1/audio/transcriptions');assert.equal(body.get('response_format'),'diarized_json');
    const wave=Buffer.from(await body.get('file').arrayBuffer());assert.equal(wave.readUInt32LE(24),16000);assert.deepEqual(wave.subarray(44),pcm);
    return Response.json({text:'甲和乙',segments:[{speaker:'S01'},{speaker:'S02'}]});
  }});
  assert.deepEqual(output,{text:'',reason:'overlap'});
});

test('MOSS speech requests a direct WAV and rejects a JSON URL',async()=>{
  const wav=pcmWav(Buffer.alloc(16));
  const synth=request=>synthesizeMoss({key:'mock',voice:'voice-id',text:'你好',request});
  assert.deepEqual(await synth(async(url,{body})=>{
    assert.equal(new URL(url).pathname,'/v1/audio/speech');
    assert.deepEqual(JSON.parse(body),{model:'moss-tts-1.5-flash',input:'你好',voice_id:'voice-id',response_format:'wav',delivery_method:'audio'});
    return new Response(wav,{headers:{'Content-Type':'audio/wav'}});
  }),wav);
  await assert.rejects(synth(async()=>Response.json({url:'https://example.test/audio.wav'})));
});

test('Nex uses its supported controls and preserves structured reply contract',async()=>{
  const result=await getModelReply({key:'mock',provider:'moss',model:'nex-n2.6',text:'先听我说',history:[],request:async(url,{body})=>{
    assert.equal(url,'https://api.mosi.cn/v1/chat/completions');
    const payload=JSON.parse(body);assert.equal(payload.thinking,undefined);assert.equal(payload.response_format.type,'json_object');
    return Response.json({choices:[{finish_reason:'stop',message:{content:'{"segments":[{"text":"嗯，你说，我在听。","emotion":"support"}],"task":null}'}}]});
  }});
  assert.equal(result.segments[0].emotion,'support');
});
