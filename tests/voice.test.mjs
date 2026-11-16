import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VadSegmenter} from '../voice-policy.mjs';
import {gate} from '../evolution/evolve.mjs';
const frame=(level=0)=>{const b=Buffer.alloc(1600);for(let i=0;i<800;i++)b.writeInt16LE(Math.round(Math.sin(i*.15)*level*32767),i*2);return b;};
test('continuous audio detects a new utterance, ignores a brief click and flushes on silence',()=>{
 let starts=0,ends=[];
 const v=new VadSegmenter({onStart:()=>starts++,onEnd:b=>ends.push(b)});
 v.push(frame(.5));v.push(frame());assert.equal(starts,0);
 for(let i=0;i<8;i++)v.push(frame(.2));
 assert.equal(starts,1);
 for(let i=0;i<14;i++)v.push(frame());
 assert.equal(ends.length,1);assert.ok(ends[0].length>10000);
 for(let i=0;i<4;i++)v.push(frame(.2));assert.equal(starts,2);
});
test('self-improvement refuses missing, duplicated and synthetic evidence',()=>{
 assert.equal(gate([]).pass,false);
 const r={case_id:'one',annotator:'r',split:'holdout',source:'human',winner:'candidate',regression:false,latency_ms:500,stop_ms:200};
 assert.equal(gate(Array.from({length:50},()=>({...r}))).pass,false);
 assert.equal(gate(Array.from({length:50},(_,i)=>({...r,case_id:String(i),source:'synthetic'}))).pass,false);
 assert.equal(gate(Array.from({length:50},(_,i)=>({...r,case_id:String(i)}))).pass,true);
});
test('quiet speech is detected and manual endpoint releases continuous background sound',()=>{
 let starts=0,ends=[];
 const v=new VadSegmenter({onStart:()=>starts++,onEnd:b=>ends.push(b)});
 assert.equal(v.finish(),false);
 for(let i=0;i<8;i++)v.push(frame(.02));
 assert.equal(starts,1);assert.equal(ends.length,0);
 assert.equal(v.finish(),true);assert.equal(ends.length,1);assert.equal(v.finish(),false);
 for(let i=0;i<8;i++)v.push(frame(.02));assert.equal(starts,2);
});
