import test from 'node:test';
import assert from 'node:assert/strict';
import {DuplexController} from '../public/duplex-controller.js';

test('backchannel holds and then resumes the same playing response',()=>{
  const duplex=new DuplexController();duplex.output('playing');
  assert.deepEqual(duplex.beginSpeech(),{action:'hold',phase:'playing'});
  assert.deepEqual(duplex.resolveSpeech('嗯嗯。'),{action:'resume',intent:'backchannel',phase:'playing'});
  assert.equal(duplex.phase,'playing');assert.equal(duplex.pending,false);
});

test('correction cancels a held response and yields to the newest input',()=>{
  const duplex=new DuplexController();duplex.output('playing');duplex.beginSpeech();
  assert.deepEqual(duplex.resolveSpeech('不是工作，是家里的事'),{action:'interrupt',intent:'correction',phase:'playing'});
});

test('backchannel during generation does not discard the in-flight request',()=>{
  const duplex=new DuplexController();duplex.output('generating');duplex.beginSpeech();
  assert.equal(duplex.resolveSpeech('好的').action,'resume');
  assert.equal(duplex.phase,'generating');
});

test('unrecognized sound safely resumes held output without inventing input',()=>{
  const duplex=new DuplexController();duplex.output('playing');duplex.beginSpeech();
  assert.deepEqual(duplex.resolveSpeech(''),{action:'resume',reason:'unrecognized',phase:'playing'});
});

test('idle speech responds normally and stale output transitions clear holds',()=>{
  const duplex=new DuplexController();
  assert.deepEqual(duplex.beginSpeech(),{action:'listen'});
  assert.deepEqual(duplex.resolveSpeech('陪我聊聊'),{action:'respond'});
  duplex.output('playing');duplex.beginSpeech();duplex.output('idle');
  assert.deepEqual(duplex.resolveSpeech(''),{action:'ignore'});
  assert.throws(()=>duplex.output('thinking'));
});
