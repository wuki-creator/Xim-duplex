import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelReply } from '../model-reply.mjs';

const result=(content,reason='stop')=>Response.json({choices:[{finish_reason:reason,message:{content}}]});
function queued(...responses) {
  const calls=[];
  const request=async (_url,options)=>{
    calls.push(JSON.parse(options.body));
    return responses.shift() || assert.fail('Unexpected additional model request');
  };
  return {calls, reply:()=>getModelReply({key:'test',model:'test',text:'加油啊',history:[],style:'warm',request})};
}

test('whitespace JSON falls back once to readable text without a task',async()=>{
  const api=queued(result('                                  '),result('加油！\n\n慢慢来，我陪你。'));
  const reply=await api.reply();
  assert.deepEqual(reply,{segments:[{text:'加油！',emotion:'warm'},{text:'慢慢来，我陪你。',emotion:'warm'}],task:null});
  assert.deepEqual(api.calls.map(r=>r.response_format.type),['json_object','text']);
});

test('a malformed mood and out-of-range task do not discard otherwise readable chat',async()=>{
  const api=queued(result(JSON.stringify({
    segments:[null,{text:'一起加油。',emotion:'constructor'},{text:'喝口水。',emotion:'calm'}],
    task:{type:'focus',minutes:999,title:'专注'},
  })));
  assert.deepEqual(await api.reply(),{segments:[{text:'一起加油。',emotion:'warm'},{text:'喝口水。',emotion:'calm'}],task:null});
  assert.equal(api.calls.length,1);
});

test('conversation-only mode drops executable tasks without losing the reply',async()=>{
  const task={type:'reminder',minutes:9,title:'喝水'};
  const api=queued(result(JSON.stringify({segments:[{text:'请确认。',emotion:'calm'}],task})));
  assert.equal((await api.reply()).task,null);
  assert.equal(api.calls.length,1);
});

test('truncated output is never shown as reply and an empty fallback is a typed failure',async()=>{
  const api=queued(result('{"segments":[', 'length'),result(''));
  await assert.rejects(api.reply(),{code:'MODEL_NO_REPLY'});
  assert.equal(api.calls.length,2);
});

test('model content filtering is not retried',async()=>{
  const api=queued(result('', 'content_filter'));
  await assert.rejects(api.reply(),{code:'MODEL_FILTERED',status:422});
  assert.equal(api.calls.length,1);
});
