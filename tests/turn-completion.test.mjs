import test from 'node:test';
import assert from 'node:assert/strict';
import {predictTurn,TurnReleaseGate} from '../turn-completion.mjs';

test('turn prediction uses loopback PCM and safely rejects bad or unavailable output',async()=>{
  const pcm=Buffer.alloc(3200);
  const prediction=await predictTurn({url:'http://localhost:18796',pcm,request:async(url,opts)=>{
    assert.equal(url,'http://localhost:18796/predict');assert.equal(opts.body,pcm);assert.equal(opts.headers.Authorization,undefined);
    return Response.json({complete:false,probability:.2});
  }});
  assert.deepEqual(prediction,{complete:false,probability:.2});
  for(const value of [{complete:'false',probability:.2},{complete:true,probability:2},{}]){
    assert.equal(await predictTurn({url:'http://localhost',pcm,request:async()=>Response.json(value)}),null);
  }
  assert.equal(await predictTurn({url:'https://outside.example',pcm,request:()=>{throw Error('must not call');}}),null);
  assert.equal(await predictTurn({url:'http://localhost',pcm,request:async()=>{throw Error('offline');}}),null);
});

test('incomplete turns wait, resumed speech invalidates stale release, complete turns release once',()=>{
  let idle=true,released=0,callback,cleared=0;
  const gate=new TurnReleaseGate({canRelease:()=>idle,onRelease:()=>released++,schedule:fn=>{callback=fn;return 1;},unschedule:()=>cleared++});
  gate.update(false);assert.equal(released,0);const stale=callback;
  idle=false;gate.cancel();stale();assert.equal(released,0);assert.equal(cleared,1);
  gate.update(true);assert.equal(released,0,'cannot answer while speaking or recognizing');
  idle=true;gate.update(true);assert.equal(released,1);
  gate.update(false);callback();assert.equal(released,2,'bounded fallback avoids waiting forever');
  gate.update(false);gate.cancel();callback();assert.equal(released,2,'closing cancels timer');
  gate.update(null);assert.equal(released,3,'unavailable predictor retains VAD behavior');
});
