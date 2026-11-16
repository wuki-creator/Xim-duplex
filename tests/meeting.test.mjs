import test from 'node:test';
import assert from 'node:assert/strict';
import {MeetingService,countRequest,explicitApproval} from '../meeting.mjs';

test('spoken meeting size and approval require explicit phrasing',()=>{
  assert.equal(countRequest('组织三个人开会，主题是机器人'),3);
  assert.equal(countRequest('加到 6 位参会者'),6);
  assert.equal(countRequest('做会议准备预计需要三分钟'),null);
  assert.equal(explicitApproval('我还没确认执行'),null);
  assert.equal(explicitApproval('请先不要确认执行全部'),null);
  assert.deepEqual(explicitApproval('确认执行 小鹿的方案。'),{target:'小鹿',all:false});
});

test('agents form proposals first, revision invalidates the old approval, and explicit confirmation produces a result',async()=>{
  const mock=[];let solves=0;
  const service=new MeetingService({key:'mock',model:'mock',request:async()=>{
    assert.ok(mock.length,'unexpected model execution');
    return Response.json({choices:[{message:{content:JSON.stringify(mock.shift())}}]});
  },compute:async()=>{solves++;return {location:'server',duration:1.5,samples:[{position:[1,2,3]}]};}});
  const signal=AbortSignal.timeout(10000);const room=service.create();
  await service.input(room.id,'组织三个人开会',null,signal);
  assert.equal(new Set(room.participants.map(p=>p.name)).size,3);
  const person=room.participants[0];
  mock.push({action:'assign',agent:person.id,task:'算机械臂轨迹'}, {title:'轨迹方案',steps:['验证初始点','验证末端点'],questions:[],operation:{job:'arm'}});
  const coordinates='计算机械臂轨迹，从 [2.6,1.45,0.3] 到 [2.45,1.13,0.65]';
  await service.input(room.id,person.name+'，'+coordinates,null,signal);
  const task=room.tasks[0];assert.equal(task.status,'proposed');assert.equal(task.rev,1);assert.equal(solves,0);
  mock.push({action:'revise',agent:person.id,task:'包含两个确认点'}, {title:'轨迹方案修改版',steps:['校验坐标'],questions:[],operation:{job:'arm'}});
  await service.input(room.id,'修改，'+coordinates,person.id,signal);
  await assert.rejects(service.approve(room.id,task.id,1,signal),{code:'STALE_PLAN'});
  assert.equal(solves,0);
  mock.push({title:'轨迹结果',summary:'目标在可达区内',deliverables:['采用了求解器的数值'],limits:['仅模拟']});
  await service.input(room.id,'确认执行 '+person.name,null,signal);
  assert.equal(solves,1);assert.equal(task.rev,2);assert.equal(task.status,'done');assert.equal(task.result.computation.location,'server');
  await service.input(room.id,'确认执行 '+person.name,null,signal);assert.equal(solves,1);
});

test('plans that require user clarification and unknown attendees cannot execute',async()=>{
  const mock=[];
  const service=new MeetingService({key:'mock',model:'mock',request:async()=>{
    assert.ok(mock.length,'unexpected execution');return Response.json({choices:[{message:{content:JSON.stringify(mock.shift())}}]});
  }});
  const room=service.create(),signal=AbortSignal.timeout(10000);
  await service.input(room.id,'组织两个人开会',null,signal);
  mock.push({action:'assign',agent:'missing',task:'任务'});await service.input(room.id,'请派任务给不存在的人',null,signal);
  assert.equal(room.tasks.length,0);
  mock.push({action:'assign',agent:room.participants[1].id,task:'计算'}, {questions:['是什么数据？'],steps:['待获取数据后计算']});
  await service.input(room.id,'请先分析这个任务',null,signal);
  const task=room.tasks[0];assert.equal(task.status,'clarifying');
  await service.input(room.id,'确认执行全部',null,signal);
  assert.equal(task.result,null);
  await assert.rejects(service.approve(room.id,task.id,task.rev,signal),{code:'STALE_PLAN'});
});

test('approved independent agent tasks run concurrently with a bounded worker count',async()=>{
  let running=0,maximum=0;
  const service=new MeetingService({key:'mock',model:'mock',request:async()=>{
    running++;maximum=Math.max(maximum,running);await new Promise(r=>setTimeout(r,35));running--;
    return Response.json({choices:[{message:{content:JSON.stringify({summary:'完成',deliverables:['已完成具体内容']})}}]});
  }});
  const room=service.create(),signal=AbortSignal.timeout(10000);
  await service.input(room.id,'组织三个人开会',null,signal);
  for(const p of room.participants)room.tasks.push({id:p.id,agent:p.id,rev:1,task:'总结',status:'proposed',plan:{title:'总结',steps:['整理'],questions:[],operation:null}});
  await service.input(room.id,'确认执行全部',null,signal);
  assert.equal(maximum,2);assert.ok(room.tasks.every(t=>t.status==='done'));
});
