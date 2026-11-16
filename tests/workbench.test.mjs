import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAction,computeWorld,generateWorkbenchImage,simpleWorkbenchAction,interpretWorkbench} from '../workbench.mjs';

test('simple affirmative scene commands map common colors without a model round trip',()=>{
  assert.equal(simpleWorkbenchAction('添加一个红色方块。').color,'coral');
  assert.equal(simpleWorkbenchAction('请添加一个蓝色球').shape,'sphere');
  assert.equal(simpleWorkbenchAction('不要添加一个红色方块'),null);
  assert.equal(simpleWorkbenchAction('先不要添加一个红色方块'),null);
});

test('tool plans only use recognized objects and reject unlisted effects',()=>{
  const objects=[{id:'obj-1'}];
  assert.deepEqual(checkAction({action:'move',target:'obj-1',position:[2,1,-1],command:'ignored'},objects),{action:'move',target:'obj-1',position:[2,1,-1]});
  for(const action of [{action:'shell',command:'anything'},{action:'move',target:'obj-2',position:[2,1,0]},{action:'move',target:'obj-1',position:[0,Infinity,1]}])assert.equal(checkAction(action,objects).action,'talk');
});

test('workbench uses local model only and rejects truncated action plans',async()=>{
  let called=0;
  const output=await interpretWorkbench({url:'http://127.0.0.1:12345',model:'local',input:'移动选中的物体',context:{},request:async(url,opts)=>{
    called++;assert.equal(url,'http://127.0.0.1:12345/v1/chat/completions');assert.equal(opts.headers.Authorization,undefined);
    return Response.json({choices:[{finish_reason:'length',message:{content:'{"action":"physics"}'}}]});
  }});
  assert.equal(called,1);assert.equal(output.action,'talk');
});

test('local arm solver returns a forward-consistent trajectory and rejects unreachable points',async()=>{
  const options={signal:AbortSignal.timeout(8000)};
  const start=[2.6,1.45,.3],target=[2.45,1.13,.65];
  const result=await computeWorld({job:'arm',start,target},options);
  assert.equal(result.location,'local');assert.deepEqual(result.samples[0].position,start);assert.deepEqual(result.samples.at(-1).position,target);
  for(const sample of result.samples){
    const [yaw,a,b]=sample.joints;
    const r=2.15*Math.cos(a)+1.75*Math.cos(a+b);
    const forward=[r*Math.cos(yaw),.8+2.15*Math.sin(a)+1.75*Math.sin(a+b),r*Math.sin(yaw)];
    assert.ok(forward.every((x,i)=>Math.abs(x-sample.position[i])<1e-9));
  }
  assert.equal((await computeWorld({job:'arm',start,target:[10,1,0]},options)).error,'UNREACHABLE');
  assert.equal((await computeWorld({job:'arm',start,target,obstacles:[{position:[2.5,1.3,.45],size:.5}]},options)).error,'PATH_BLOCKED');
});

test('world solver estimates clean free fall and refuses non-loopback worker URLs',async()=>{
  const signal=AbortSignal.timeout(8000);
  const input={job:'physics',objects:[{id:'obj-1',shape:'sphere',size:1,position:[2,3,0]}]};
  const report=await computeWorld(input,{signal});
  assert.deepEqual(report.objects,[{id:'obj-1',dropHeight:2.5,fallTime:.714,impactSpeed:7.004}]);
  await assert.rejects(computeWorld(input,{signal,remote:'https://example.test/'}),{message:'COMPUTE_CONFIGURATION'});
});

test('image generation sends one fixed-size image request and accepts only embedded raster bytes',async()=>{
 const input={url:'http://127.0.0.1:18084',model:'local-image',prompt:'日落时分的青绿色实验台'};
 const output=await generateWorkbenchImage({...input,request:async(url,options)=>{
   assert.equal(url,'http://127.0.0.1:18084/v1/images/generations');assert.equal(options.redirect,'error');
   const payload=JSON.parse(options.body);assert.equal(payload.n,1);assert.equal(payload.size,'768x768');assert.equal(payload.response_format,'b64_json');assert.equal(options.headers.Authorization,undefined);
   return Response.json({data:[{b64_json:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]).toString('base64')}]});
 }});
 assert.match(output.url,/^data:image\/png;base64,/);
 await assert.rejects(generateWorkbenchImage({...input,request:async()=>Response.json({data:[{url:'javascript:alert(1)'}]})}));
});
