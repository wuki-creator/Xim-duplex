import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export function gate(rows){
  if(!Array.isArray(rows)||rows.length<50)return {pass:false,reason:'At least 50 independent human comparisons are required'};
  const seen=new Set();let wins=0,losses=0;
  for(const r of rows){
    if(!r.case_id||seen.has(r.case_id)||!r.annotator||r.split!=='holdout'||r.source!=='human'||
       !['candidate','baseline','tie'].includes(r.winner)||typeof r.regression!=='boolean'||
       !Number.isFinite(r.latency_ms)||r.latency_ms<0||!Number.isFinite(r.stop_ms)||r.stop_ms<0)return {pass:false,reason:'Invalid or duplicate holdout evidence'};
    seen.add(r.case_id);if(r.regression)return {pass:false,reason:'Safety or interruption regression'};
    wins+=r.winner==='candidate';losses+=r.winner==='baseline';
  }
  const n=wins+losses;if(n<30)return {pass:false,reason:'Too few decisive comparisons'};
  const p=wins/n,z=1.96,lower=(p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);
  const percentile=(k)=>rows.map(r=>r[k]).sort((a,b)=>a-b)[Math.ceil(rows.length*.95)-1];
  return {pass:lower>.5&&percentile('latency_ms')<=4000&&percentile('stop_ms')<=500,wins,losses,lower95:lower,p95Latency:percentile('latency_ms'),p95Stop:percentile('stop_ms')};
}
async function main(){
 const [cmd,arg]=process.argv.slice(2);
 const active=JSON.parse(await fs.readFile(path.join(root,'active.json'),'utf8'));
 if(cmd==='propose'){
  const seen=new Set();
  const feedback=(await fs.readFile(arg,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)).filter(r=>{
    if(!r.id||seen.has(r.id)||r.policy!==active.id||r.consent!==true||r.source!=='human_explicit_feedback'||r.rating!=='unhelpful')return false;
    seen.add(r.id);return true;
  });
  if(feedback.length<10)throw Error('Need 10 explicitly consented negative examples; no synthetic replacements');
  // Prompt policy mutation is reviewable and separate from model weights.
  const counts={short:0,listen:0};
  for(const r of feedback){counts.short+=(r.segments||[]).reduce((n,s)=>n+(s.text?.length||0),0)>250;counts.listen+=/累|难过|烦|别给建议/.test(r.prompt||'');}
  const addition=counts.listen>=counts.short?'面对情绪表达，先复述具体困扰再简短回应；除非用户邀请，不连续给建议。':'先用一到两句直接回应；只在用户要求展开时增加解释。';
  if(active.instruction.includes(addition))throw Error('This policy mutation already exists; investigate new failure modes instead of repeating it');
  const candidate={id:'candidate-'+Date.now(),parent:active.id,instruction:active.instruction+' '+addition,trainingHash:crypto.createHash('sha256').update(JSON.stringify(feedback)).digest('hex'),count:feedback.length};
  await fs.writeFile(path.join(root,'candidate.json'),JSON.stringify(candidate,null,2));
  console.log(JSON.stringify({created:candidate.id,count:candidate.count,promoted:false}));
 }else if(cmd==='promote'){
  const candidate=JSON.parse(await fs.readFile(path.join(root,'candidate.json'),'utf8'));
  const report=JSON.parse(await fs.readFile(arg,'utf8'));
  if(candidate.parent!==active.id||report.candidate!==candidate.id||report.baseline!==active.id)throw Error('Version mismatch');
  const decision=gate(report.rows);
  if(!decision.pass)throw Error('Promotion rejected: '+JSON.stringify(decision));
  await fs.mkdir(path.join(root,'history'),{recursive:true});
  await fs.writeFile(path.join(root,'history',active.id.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json'),JSON.stringify(active,null,2));
  await fs.writeFile(path.join(root,'active.json'),JSON.stringify({...candidate,evidence:decision},null,2));
  console.log('Promoted. Restart server to activate; previous policy remains in history.');
 }else if(cmd==='rollback'){
  if(!arg||!/^[a-zA-Z0-9_-]+$/.test(arg))throw Error('Specify an existing policy ID');
  const previous=JSON.parse(await fs.readFile(path.join(root,'history',arg+'.json'),'utf8'));
  if(previous.id!==arg||typeof previous.instruction!=='string')throw Error('Invalid policy archive');
  await fs.writeFile(path.join(root,'history',active.id.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json'),JSON.stringify(active,null,2));
  await fs.writeFile(path.join(root,'active.json'),JSON.stringify(previous,null,2));console.log('Restored '+arg+'. Restart server to activate.');
 }else{console.log('node evolution/evolve.mjs propose data/feedback.jsonl\nnode evolution/evolve.mjs promote evaluation.json\nnode evolution/evolve.mjs rollback policy-id');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
