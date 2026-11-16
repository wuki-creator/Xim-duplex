import test from 'node:test';
import assert from 'node:assert/strict';
import {loopbackUrl,localChat,localNanoSpeech} from '../local-models.mjs';
import {pcmWav} from '../moss-models.mjs';

test('local inference only allows loopback and does not send remote API keys',async()=>{
  for(const address of ['https://localhost:1','http://example.org','http://127.0.0.1.evil.test','http://u:p@127.0.0.1'])assert.throws(()=>loopbackUrl(address,'/v1/chat/completions'));
  const reply=await localChat({url:'http://127.0.0.1:9999',model:'test',text:'不是工作，是家里',history:[{role:'user',content:'有点烦'}],interruption:{phase:'playing',heardPrefix:'工作让你'},request:async(url,opts)=>{
    assert.equal(url,'http://127.0.0.1:9999/v1/chat/completions');assert.equal(opts.headers.Authorization,undefined);
    assert.equal(JSON.parse(JSON.parse(opts.body).messages.at(-1).content).interruption.heard_prefix,'工作让你');
    return Response.json({choices:[{finish_reason:'stop',message:{content:'明白，是家里的事。'}}]});
  }});
  assert.deepEqual(reply,{segments:[{text:'明白，是家里的事。',emotion:'warm'}],task:null});
});
test('local Nano integration accepts only bounded WAV bytes from local worker',async()=>{
  const wav=pcmWav(Buffer.alloc(16));
  const result=await localNanoSpeech({url:'http://localhost:18083',text:'你好',demoId:'sample',request:async(url,opts)=>{
    assert.equal(url,'http://localhost:18083/api/generate');assert.equal(opts.body.get('text'),'你好');assert.equal(opts.body.get('demo_id'),'sample');
    return Response.json({audio_base64:wav.toString('base64')});
  }});
  assert.deepEqual(result,wav);
  await assert.rejects(localNanoSpeech({url:'http://localhost:18083',text:'你好',request:async()=>Response.json({audio_base64:Buffer.from('wrong').toString('base64')})}));
});
