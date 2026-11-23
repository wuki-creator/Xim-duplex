import test from 'node:test';
import assert from 'node:assert/strict';
import {InteractionLog} from '../public/interaction-log.js';

test('interaction trace records timing and intent but never transcript or audio',()=>{
  let tick=0;const log=new InteractionLog({now:()=>++tick,wallNow:()=> '2026-11-23T00:00:00.000Z'});
  log.mark('speech.start',{phase:'playing'});
  const event=log.mark('duplex.resume',{phase:'playing',intent:'backchannel'});
  assert.equal(event.t_ms,2);
  const out=log.export({version:'0.10.0',model:'local-test'});
  assert.equal(out.schema,'xim-interaction-trace-v1');assert.equal(out.events.length,2);
  assert.equal(out.audio_included,false);assert.equal(out.transcript_included,false);
  assert.equal(JSON.stringify(out).includes('嗯嗯'),false);
});

test('interaction trace is bounded and rejects arbitrary fields',()=>{
  const log=new InteractionLog({now:()=>1,limit:2});
  log.mark('one',{transcript:'private'});log.mark('two');log.mark('three');
  assert.deepEqual(log.events.map(event=>event.type),['two','three']);
  assert.equal(Object.hasOwn(log.events[0],'transcript'),false);
  assert.throws(()=>log.mark('bad event'));
});
