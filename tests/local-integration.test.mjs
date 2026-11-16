import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {pcmWav} from '../audio.mjs';

test('server uses local chat and local TTS without a cloud key', {timeout:15000},async t=>{
  const calls=[];
  const worker=http.createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk.toString('utf8');
    calls.push(req.url);
    if(req.url==='/health'){res.end('{"ready":true,"model":"test-asr"}');return;}
    if(req.url==='/v1/chat/completions'){
      assert.equal(JSON.parse(data).model,'local-model');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"segments":[{"text":"很高兴见到你。","emotion":"joy"}]}'}}]}));return;
    }
    if(req.url==='/v1/audio/speech'){
      assert.equal(JSON.parse(data).input,'很高兴见到你。');assert.equal(JSON.parse(data).model,'test-tts');res.setHeader('Content-Type','audio/wav');res.end(pcmWav(Buffer.alloc(30)));return;
    }
    res.writeHead(404);res.end();
  });
  worker.listen(0,'127.0.0.1');await once(worker,'listening');
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const local='http://127.0.0.1:'+worker.address().port;
  const app=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),XIM_CONFIG:'missing-config',DEEPSEEK_API_KEY:'',ASR_URL:local,XIM_LOCAL_CHAT_URL:local,XIM_LOCAL_CHAT_MODEL:'local-model',XIM_LOCAL_TTS_URL:local,XIM_LOCAL_TTS_MODEL:'test-tts',MOSS_API_KEY:'retired-key-must-be-ignored',XIM_CHAT_PROVIDER:'moss',MOSS_LIVE:'1'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{app.kill();worker.closeAllConnections();await new Promise(r=>worker.close(r));});
  await once(app.stdout,'data');
  const base='http://127.0.0.1:'+port,boot=await fetch(base+'/api/bootstrap').then(r=>r.json());
  assert.equal(boot.configured,true);assert.equal(boot.voiceMode,'cascade');assert.equal(boot.serverTts,true);assert.equal(boot.voiceLive,false);assert.equal(boot.voiceEngine,'xim-cascade');assert.equal(boot.cloudAsr,false);
  const post=(url,body)=>fetch(base+'/api/'+url,{method:'POST',headers:{'Content-Type':'application/json','X-Bandi-Token':boot.token},body:JSON.stringify(body)});
  const chat=await post('chat',{text:'你好',history:[]}).then(r=>r.json());assert.equal(chat.model,'local-model');
  const speech=await post('speech',{id:chat.id,offset:0,end:chat.segments[0].text.length});assert.equal(speech.status,200);
  assert.equal(Buffer.from(await speech.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  assert.ok(calls.includes('/v1/chat/completions')&&calls.includes('/v1/audio/speech'));
});
