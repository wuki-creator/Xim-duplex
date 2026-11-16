import test from 'node:test';
import assert from 'node:assert/strict';
import {loopbackUrl,localChat,localSpeech} from '../local-models.mjs';
import {pcmWav} from '../audio.mjs';

test('local inference only allows loopback and does not send remote API keys',async()=>{
  for(const address of ['https://localhost:1','http://example.org','http://127.0.0.1.evil.test','http://u:p@127.0.0.1'])assert.throws(()=>loopbackUrl(address,'/v1/chat/completions'));
  const reply=await localChat({url:'http://127.0.0.1:9999',model:'test',text:'不是工作，是家里',history:[{role:'user',content:'有点烦'}],interruption:{phase:'playing',heardPrefix:'工作让你'},request:async(url,opts)=>{
    assert.equal(url,'http://127.0.0.1:9999/v1/chat/completions');assert.equal(opts.headers.Authorization,undefined);
    assert.equal(JSON.parse(JSON.parse(opts.body).messages.at(-1).content).interruption.heard_prefix,'工作让你');
    return Response.json({choices:[{finish_reason:'stop',message:{content:'明白，是家里的事。'}}]});
  }});
  assert.deepEqual(reply,{segments:[{text:'明白，是家里的事。',emotion:'warm'}],task:null});
});
test('local speech contract accepts only bounded WAV bytes from local worker',async()=>{
  const wav=pcmWav(Buffer.alloc(16));
  const result=await localSpeech({url:'http://localhost:18083',text:'你好',model:'test-tts',voice:'sample',request:async(url,opts)=>{
    assert.equal(url,'http://localhost:18083/v1/audio/speech');assert.deepEqual(JSON.parse(opts.body),{model:'test-tts',input:'你好',voice:'sample',response_format:'wav',emotion:'warm'});assert.equal(opts.headers.Authorization,undefined);
    return new Response(wav,{headers:{'Content-Type':'audio/wav'}});
  }});
  assert.deepEqual(result,wav);
  await assert.rejects(localSpeech({url:'http://localhost:18083',text:'你好',request:async()=>new Response('wrong')}));
});
