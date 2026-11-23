import test from 'node:test';
import assert from 'node:assert/strict';
import {DialogueState,speechChunks} from '../public/dialogue-state.js';

test('interruption retains user intent and only acknowledged assistant audio',()=>{
  const state=new DialogueState(),one=state.begin('介绍两个方法');
  state.complete(one,'第一种是休息。第二种是运动。',true);
  state.acknowledge(one,7);state.interrupt(one);
  const two=state.begin('等等，先说第一种怎么做');
  const request=state.request(two);
  assert.equal(two.parent,one.id);
  assert.deepEqual(request.history,[{role:'user',content:'介绍两个方法'},{role:'assistant',content:'第一种是休息。'}]);
  assert.equal(request.interruption.unplayedCharacters,7);
  assert.equal(request.interruption.heardPrefix,'第一种是休息。');
  state.acknowledge(one,14); // A delayed completion must not resurrect cancelled playback.
  assert.equal(one.heard,7);
});
test('interrupting generation preserves the question even before a reply exists',()=>{
  const state=new DialogueState(),one=state.begin('明天去哪里');state.interrupt(one);
  const two=state.begin('我改成后天去');
  assert.deepEqual(state.request(two).history,[{role:'user',content:'明天去哪里'}]);
  assert.equal(two.interruption.phase,'generating');
  state.complete(two,'可以，按后天来计划。',false);
  const three=state.begin('好');assert.equal(three.interruption,null);
  assert.equal(state.request(three).history.at(-1).content,'可以，按后天来计划。');
  state.clear();assert.deepEqual(state.request(state.begin('重新聊')).history,[]);
});
test('without boundary events no unconfirmed text becomes shared spoken history',()=>{
  const state=new DialogueState(),one=state.begin('你好');state.complete(one,'你好，很高兴见到你。',true);state.interrupt(one);
  assert.deepEqual(state.request(state.begin('先等等')).history,[{role:'user',content:'你好'}]);
});
test('playback chunks preserve UTF-16 offsets, punctuation and all text',()=>{
  const text='🙂你好。这里是一段比较长的介绍，请慢慢听。\n再见！';const chunks=speechChunks(text,8);
  assert.equal(chunks.map(c=>c.text).join(''),text);
  for(const c of chunks)assert.equal(text.slice(c.start,c.end),c.text);
});
