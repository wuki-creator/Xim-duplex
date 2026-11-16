import test from 'node:test';
import assert from 'node:assert/strict';
import {runSpeechQueue} from '../public/speech-queue.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const chunks=['第一句。','第二句。','第三句。'].map((text,index)=>({text,start:index*4,end:(index+1)*4}));

test('prepares only the next chunk during playback and acknowledges only ended audio',async()=>{
  const controller=new AbortController(),played=[],loaded=[],heard=[],ends=chunks.map(deferred);
  const run=runSpeechQueue({chunks,signal:controller.signal,
    load:async(chunk,signal)=>{assert.equal(signal,controller.signal);loaded.push(chunk.text);return chunk.text;},
    play:(audio,chunk)=>{assert.equal(audio,chunk.text);played.push(audio);return ends[played.length-1].promise;},
    fallback:()=>assert.fail('unexpected fallback'),acknowledge:chunk=>heard.push(chunk.end)});
  await tick();assert.deepEqual(loaded,['第一句。','第二句。']);assert.deepEqual(played,['第一句。']);assert.deepEqual(heard,[]);
  ends[0].resolve();await tick();assert.deepEqual(loaded,chunks.map(x=>x.text));assert.deepEqual(played,['第一句。','第二句。']);assert.deepEqual(heard,[4]);
  ends[1].resolve();await tick();ends[2].resolve();assert.deepEqual(await run,{status:'complete'});assert.deepEqual(heard,[4,8,12]);
});

test('cancelling during current playback discards a late next audio buffer without acknowledging it',async()=>{
  const controller=new AbortController(),next=deferred(),playing=deferred(),played=[],heard=[],loads=[];
  const run=runSpeechQueue({chunks,signal:controller.signal,load:(chunk,signal)=>{
    assert.equal(signal,controller.signal);loads.push(chunk.text);return loads.length===1?Promise.resolve('first'):next.promise;
  },play:audio=>{played.push(audio);return playing.promise;},fallback:()=>assert.fail('no fallback after cancellation'),acknowledge:chunk=>heard.push(chunk.end)});
  await tick();controller.abort();assert.deepEqual(await run,{status:'cancelled'});
  next.resolve('stale');playing.resolve();await tick();assert.deepEqual(played,['first']);assert.deepEqual(heard,[]);assert.equal(loads.length,2);
});

test('late rejected prefetch and playback after cancellation are already handled',async()=>{
  const controller=new AbortController(),next=deferred(),playing=deferred();let loads=0;
  const run=runSpeechQueue({chunks,signal:controller.signal,load:()=>++loads===1?Promise.resolve('first'):next.promise,
    play:()=>playing.promise,fallback:()=>assert.fail('unexpected fallback'),acknowledge:()=>assert.fail('cancelled audio acknowledged')});
  await tick();controller.abort();await run;
  next.reject(Error('request aborted'));playing.reject(Error('playback stopped'));await tick();
});

test('failed next load uses device voice for that and remaining chunks without replaying the first',async()=>{
  const controller=new AbortController(),first=deferred(),spoken=[],loaded=[],heard=[];
  const run=runSpeechQueue({chunks,signal:controller.signal,load:async chunk=>{
    loaded.push(chunk.text);if(loaded.length===2)throw Error('TTS unavailable');return 'first';
  },play:()=>{spoken.push('local:first');return first.promise;},fallback:async chunk=>{spoken.push('device:'+chunk.text);},acknowledge:chunk=>heard.push(chunk.end)});
  await tick();assert.deepEqual(heard,[]);first.resolve();await run;
  assert.deepEqual(spoken,['local:first','device:第二句。','device:第三句。']);assert.equal(loaded.length,2);assert.deepEqual(heard,[4,8,12]);
});

test('epoch change prevents old audio playing even if a loader ignores abort',async()=>{
  const controller=new AbortController(),audio=deferred();let current=true;
  const run=runSpeechQueue({chunks,signal:controller.signal,isCurrent:()=>current,load:()=>audio.promise,
    play:()=>assert.fail('stale audio played'),fallback:()=>assert.fail('stale fallback'),acknowledge:()=>assert.fail('stale acknowledgement')});
  current=false;audio.resolve('old');assert.deepEqual(await run,{status:'cancelled'});
});

test('blank chunks preserve offsets and do not discard the single prefetched buffer',async()=>{
  const controller=new AbortController(),loaded=[],heard=[];
  const parts=[{text:'好。',end:2},{text:'\n',end:3},{text:'再见。',end:6}];
  await runSpeechQueue({chunks:parts,signal:controller.signal,load:async chunk=>{loaded.push(chunk.text);return chunk.text;},
    play:async()=>{},fallback:()=>assert.fail('unexpected fallback'),acknowledge:chunk=>heard.push(chunk.end)});
  assert.deepEqual(loaded,['好。','再见。']);assert.deepEqual(heard,[2,3,6]);
});

test('device voice errors reject without marking unplayed audio as heard',async()=>{
  const controller=new AbortController(),heard=[];
  await assert.rejects(runSpeechQueue({chunks,signal:controller.signal,load:null,play:()=>assert.fail('no local audio'),
    fallback:async()=>{throw Error('device failed');},acknowledge:chunk=>heard.push(chunk.end)}),/device failed/);
  assert.deepEqual(heard,[]);
});
