import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('voice transport authenticates, survives malformed origins, and drops superseded transcription', {timeout:15000}, async t=>{
  let calls=0,recognizing=false,retries=0;
  const asr=http.createServer(async(req,res)=>{
    if(req.url==='/health'){res.end('{"ready":true}');return;}
    for await(const chunk of req){}
    if(recognizing){retries++;res.writeHead(429);res.end('{}');return;}
    recognizing=true;
    const i=++calls;await sleep(i===1?450:10);
    recognizing=false;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:i===1?'旧内容':'新的话'}));
  });
  asr.listen(0,'127.0.0.1');await once(asr,'listening');
  const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
  const app=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),ASR_URL:'http://127.0.0.1:'+asr.address().port,DEEPSEEK_API_KEY:'',XIM_CONFIG:'missing-test-config.json'},stdio:['ignore','pipe','pipe']});
  let sockets=[];t.after(async()=>{for(const s of sockets)s.terminate();app.kill();asr.closeAllConnections();await new Promise(r=>asr.close(r));});
  await once(app.stdout,'data');
  const base='http://127.0.0.1:'+port;
  const boot=await fetch(base+'/api/bootstrap').then(r=>r.json());assert.equal(boot.asrReady,true);
  const bad=net.connect(port,'127.0.0.1');bad.on('error',()=>{});bad.write('GET /api/voice HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: broken\r\n\r\n');await once(bad,'close');
  assert.equal((await fetch(base+'/api/bootstrap')).status,200);
  const denied=new WebSocket(base.replace('http','ws')+'/api/voice',{origin:base});sockets.push(denied);await once(denied,'open');denied.send('{"token":"wrong"}');assert.equal((await once(denied,'close'))[0],1008);
  const ws=new WebSocket(base.replace('http','ws')+'/api/voice',{origin:base});sockets.push(ws);const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await once(ws,'open');ws.send(JSON.stringify({token:boot.token}));
  while(!events.some(e=>e.type==='ready'))await sleep(10);
  const loud=Buffer.alloc(1600);for(let i=0;i<800;i++)loud.writeInt16LE(6000,i*2);const quiet=Buffer.alloc(1600);
  const utterance=()=>{for(let i=0;i<8;i++)ws.send(loud);for(let i=0;i<16;i++)ws.send(quiet);};
  utterance();while(calls<1)await sleep(10);utterance();
  for(let i=0;i<100&&!events.some(e=>e.type==='transcript');i++)await sleep(25);
  assert.equal(events.filter(e=>e.type==='speech.start').length,2);
  assert.deepEqual(events.filter(e=>e.type==='transcript').map(e=>e.text),['新的话']);
  assert.ok(retries>0,'waits for the superseded ASR request without ending microphone capture');
  ws.send(Buffer.alloc(3));assert.equal((await once(ws,'close'))[0],1008);
});
