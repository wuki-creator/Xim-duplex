// Exercise the real product prompts/parsers against an explicitly selected
// loopback model. No proposal is approved and no compute/image/download runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {localChat,loopbackUrl} from '../local-models.mjs';
import {interpretWorkbench} from '../workbench.mjs';
import {MeetingService} from '../meeting.mjs';

if(process.argv.includes('--help')){console.log('node scripts/evaluate_runtime_contracts.mjs --url http://127.0.0.1:PORT --model xim-chat-v1 --output reports/runtime.json');process.exit(0);}
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,all)=>{
  if(index%2===0)pairs.push([value,all[index+1]]);return pairs;
},[]));
const url=args['--url'],model=args['--model'],output=args['--output'];
if(!url||!model||!output)throw Error('Explicit --url, --model and a new --output file are required');
loopbackUrl(url,'/health');
try{await fs.access(output);throw Error('Output already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
const healthResponse=await fetch(loopbackUrl(url,'/health'),{redirect:'error',signal:AbortSignal.timeout(10000)});
const health=await healthResponse.json();
if(!healthResponse.ok||health.ready!==true||health.model!==model)throw Error('Selected local model is not ready');
const policy=JSON.parse(await fs.readFile(new URL('../evolution/active.json',import.meta.url),'utf8'));
const records=[];
async function run(id,category,invoke,accept){
  const calls=[],started=performance.now();
  const request=async(address,options)=>{
    const body=JSON.parse(options.body),response=await fetch(address,options);
    calls.push({messages:body.messages,max_tokens:body.max_tokens,response:await response.clone().json()});
    return response;
  };
  const signal=AbortSignal.timeout(180000);
  try{
    const result=await invoke({url,model,request,signal});
    records.push({id,category,accepted:accept(result),model_calls:calls.length,result,calls,
      seconds:(performance.now()-started)/1000});
  }catch(error){
    records.push({id,category,accepted:false,model_calls:calls.length,error:error.message,calls,
      seconds:(performance.now()-started)/1000});
  }
  console.log(JSON.stringify({case:id,accepted:records.at(-1).accepted}));
}
for(const [id,text,history,interruption] of [
  ['chat-warm','今天做了很久实验，有点累。',[],null],
  ['chat-curious','你想和我一起设计什么样的桌面小玩具？',[],null],
  ['chat-correction','不是工作，是家里的事。',[{role:'user',content:'最近很烦'},{role:'assistant',content:'工作让你很累'}],{phase:'playing',heardPrefix:'工作让你很累'}],
  ['chat-yield','等一下，我还没说完。',[{role:'user',content:'我想说明一下情况'}],{phase:'playing',heardPrefix:'好，我们先'}],
  ['chat-boundary','先讨论一下机械臂要怎么移动，暂时不要执行。',[],null],
])await run(id,'chat',config=>localChat({...config,text,history,interruption,styleInstruction:policy.instruction}),result=>
  Array.isArray(result.segments)&&result.segments.length>0&&result.task===null);

const objects=[{id:'obj-201',name:'样机',shape:'box',color:'jade',position:[1,1,0]}];
for(const [id,input,expected] of [
  ['scene-move','将选中的样机移动到 [2,1,-1]。',{action:'move',target:'obj-201',position:[2,1,-1]}],
  ['scene-paint','把样机涂成红色。',{action:'paint',target:'obj-201',color:'coral'}],
  ['scene-download','我想下载当前场景的JSON文件。',{action:'download',file:'scene'}],
  ['scene-trajectory','提出移动到 [2.5,1,0.5] 的轨迹计算请求。',{action:'trajectory',position:[2.5,1,.5]}],
])await run(id,'workbench',config=>interpretWorkbench({...config,input,context:{objects,selected:'obj-201'}}),result=>
  JSON.stringify(result)===JSON.stringify(expected));

for(const [id,mode] of [['meeting-proposal','proposal'],['meeting-discussion','discussion']]){
  await run(id,'meeting',async config=>{
    const service=new MeetingService({...config,compute:async()=>{throw Error('Evaluation must never execute tools');}});
    const created=service.create(),room=service.get(created.id);
    service.resize(room,2,'桌面玩具演示');
    room.participants[0].name='林舟';room.participants[1].name='夏禾';
    room.messages=[];
    return service.input(room.id,mode==='proposal'?'林舟，请为明天十分钟的演示制作检查清单':'让林舟和夏禾讨论一下怎么测试语音接话体验',null,config.signal);
  },result=>mode==='proposal'?
    result.tasks.some(task=>task.status==='proposed'&&task.plan.steps.length>0&&task.result===null):
    result.messages.some(message=>result.participants.some(person=>person.id===message.by))&&result.tasks.length===0);
}
const report={model_name:model,status:'completed',created_at_utc:new Date().toISOString(),health,policy:policy.id,
  source_files:['scripts/evaluate_runtime_contracts.mjs','local-models.mjs','meeting.mjs','workbench.mjs','evolution/active.json'],
  examples:records.length,accepted:records.filter(record=>record.accepted).length,records,
  limitations:'Contract checks and four exact scene targets only. Chat content and meeting plans require human review. No external tools, human preference test, real voice interaction or automatic deployment.'};
report.source_sha256=Object.fromEntries(await Promise.all(report.source_files.map(async file=>
  [file,createHash('sha256').update(await fs.readFile(new URL('../'+file,import.meta.url))).digest('hex')])));
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({report:path.resolve(output),accepted:report.accepted,examples:report.examples}));
