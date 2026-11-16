import {randomUUID,randomInt} from 'node:crypto';
import {computeWorld} from './workbench.mjs';

const names=['小鹿','阿晨','林舟','夏禾','苏墨','江雨','安可','叶青','方圆','云川','宁安','晓月'];
const roles=['方案设计','工程实现','资料分析','体验设计','风险验证','任务协调','结果评估','质量复核'];
const cut=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const lines=(v,n=5)=>Array.isArray(v)?v.map(s=>cut(s,300)).filter(Boolean).slice(0,n):[];
const chinese={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
export class MeetingError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
const invalid=(code,message,status)=>{throw new MeetingError(code,message,status);};

export function countRequest(text){
  if(!/(?:开会|会议|参会|开个会|参加|参与|席位|Agent)/iu.test(text))return null;
  const digits=text.match(/(\d{1,2}|[一二两三四五六七八九十])\s*(?:个人|名(?:与会者|参与者|参会者|成员|Agent)?|位(?:与会者|参与者|参会者|成员|Agent)?|人|个\s*(?:Agent|席位|参会者|与会者|成员))/iu)?.[1];
  return digits?(chinese[digits]??Number(digits)):null;
}

export function explicitApproval(text){
  const match=/^\s*(?:确认执行|批准执行|同意执行)\s*[:：]?\s*([\p{Script=Han}a-zA-Z0-9 -]{0,24})[。！？.!?]?\s*$/u.exec(text);
  if(!match)return null;
  const target=match[1].trim().replace(/的(?:方案|任务)$/u,'').trim();return {target,all:/^(?:全部|所有|all)$/i.test(target)};
}

async function modelJSON({key,model,system,context,signal,request,maxTokens=1200}){
  const response=await request('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:maxTokens,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(context)}]})});
  if(!response.ok){await response.body?.cancel();throw Error('Model unavailable');}
  const value=await response.json();return JSON.parse(value.choices[0].message.content);
}

const router=`你是伴点虚拟会议室的指令路由器。只输出一个 JSON 对象。action可为 organize、assign、revise、ask、discuss、talk。绝对不能输出执行或批准。组织会议提供 count（1–8的整数）和 topic；派活提供 agent（现有 participant.id）和 task；修改用 revise，并给 task 指令；用户补充当前任务的追问信息时也用 revise。ask 是向某个 agent 询问，discuss 是让多名 Agent 讨论，不执行任务。agent 只能从参与者选择，用户提供近音名字时对照现有姓名；没有明确的人且未选中时请澄清，不自行分配。topic 和 task 都只用用户的内容，不猜测。一般聊天用 {"action":"talk","reply":"..."}。没有明确的人数，提示可说“组织3个人开会”。未确认不开始执行，只能提方案或讨论。`;
const baseRules='你是虚拟会议参与者。按给出的名字、职责、任务和对话回应。只使用提供的事实，不声称已外部搜索、已安排日历或已操作他人系统。只输出 JSON，字段和值使用要求的结构。';

export class MeetingService{
  constructor({key,model,remote='',request=fetch,compute=computeWorld}){Object.assign(this,{key,model,remote,request,compute});this.rooms=new Map();}
  get(id){const room=this.rooms.get(id);if(!room)invalid('MEETING_EXPIRED','这场会议已结束，请重新创建。',404);room.touched=Date.now();return room;}
  create(){
    for(const [id,room] of this.rooms)if(!room.busy&&Date.now()-room.touched>7200000)this.rooms.delete(id);
    if(this.rooms.size>=20){const oldest=[...this.rooms.values()].filter(r=>!r.busy).sort((a,b)=>a.touched-b.touched)[0];if(!oldest)invalid('MEETING_BUSY','请等待现有会议完成。',429);this.rooms.delete(oldest.id);}
    const room={id:randomUUID(),topic:'未命名会议',participants:[],tasks:[],messages:[],next:0,busy:false,touched:Date.now()};this.rooms.set(room.id,room);
    this.note(room,'moderator','可以先说「组织三个人开会」，再点名给他们派活。');return this.snapshot(room);
  }
  snapshot(room){return {id:room.id,topic:room.topic,participants:room.participants,tasks:room.tasks,messages:room.messages,busy:room.busy};}
  note(room,by,text){if(text){room.messages.push({by,text:cut(text,1200)});if(room.messages.length>60)room.messages.shift();}}
  resize(room,count,topic=''){
    if(!Number.isInteger(count)||count<1||count>8)invalid('INVALID_COUNT','会议可安排 1 到 8 位虚拟参会者。');
    const used=new Set(room.tasks.map(t=>t.agent));
    if(count<room.participants.filter(p=>used.has(p.id)).length)invalid('PARTICIPANT_ASSIGNED','已派活的参会者保留在场，请开一场新会议以更换阵容。');
    while(room.participants.length>count){
      const index=room.participants.findLastIndex(p=>!used.has(p.id));
      if(index<0)invalid('PARTICIPANT_ASSIGNED','已派活的参会者保留在场，请开一场新会议以更换阵容。');
      room.participants.splice(index,1);
    }
    while(room.participants.length<count){
      const existing=room.participants.map(p=>p.name),pool=names.filter(n=>!existing.includes(n));
      room.participants.push({id:'a-'+(++room.next),name:pool[randomInt(pool.length)],role:roles[room.participants.length]});
    }
    if(topic)room.topic=cut(topic,80);
    this.note(room,'moderator',`现在有 ${count} 位参会者：${room.participants.map(x=>x.name).join('、')}。你可以点名派活。`);
  }
  async ask(system,context,signal,maxTokens){if(!this.key)invalid('MODEL_NOT_CONFIGURED','DeepSeek 未配置。',503);return modelJSON({...this,key:this.key,model:this.model,request:this.request,system,context,signal,maxTokens});}
  context(room){return {topic:room.topic,participants:room.participants,tasks:room.tasks.slice(-8).map(({id,agent,task,status,plan})=>({id,agent,task,status,plan})),history:room.messages.slice(-12)};}
  async input(id,text,selected,signal){
    const room=this.get(id);if(room.busy)invalid('MEETING_BUSY','上一项正在进行，请稍等。',409);
    if(typeof text!=='string'||!text.trim()||text.length>1000)invalid('INVALID_INPUT','请输入有效的会议指令。');
    room.busy=true;this.note(room,'user',text);
    try{
      const approval=explicitApproval(text);
      if(approval){
        const candidates=room.tasks.filter(t=>t.status==='proposed'&&(!approval.target||approval.all||room.participants.find(p=>p.id===t.agent)?.name===approval.target));
        if(!candidates.length||(!approval.target&&candidates.length!==1))this.note(room,'moderator','请先等方案形成，再说「确认执行 人名」或「确认执行全部」。');
        else await this.execute(room,candidates,signal);
      }else{
        const count=countRequest(text);
        if(count!==null){
          const topic=text.match(/(?:主题(?:是|为)?|讨论主题(?:是|为)?)[:：\s]*([^。！？]+)/)?.[1];
          this.resize(room,count,topic);
        }else{
          const intent=await this.ask(router,{...this.context(room),text,selected},signal,550);
          await this.route(room,intent,text,selected,signal);
        }
      }
    }catch(e){
      if(e instanceof MeetingError)this.note(room,'moderator',e.message);
      else if(!signal.aborted)this.note(room,'moderator','这条指令暂时没完成，请重试。');
    }finally{room.busy=false;}
    return this.snapshot(room);
  }
  async route(room,intent,input,selected,signal){
    const agent=room.participants.find(p=>p.id===(intent.agent||selected));
    if(intent.action==='organize'){this.resize(room,intent.count,intent.topic);return;}
    if(['assign','revise'].includes(intent.action)){
      if(!agent){this.note(room,'moderator','请指明参会者的名字，再告诉他要完成什么。');return;}
      const task=cut(intent.task,850);if(!task){this.note(room,agent.id,'你希望我交付什么？');return;}
      let current=room.tasks.findLast(t=>t.agent===agent.id&&['clarifying','proposed'].includes(t.status));
      if(intent.action==='revise'&&!current){this.note(room,agent.id,'我还没有待修改的方案，请先给我派活。');return;}
      const scope=intent.action==='revise'?cut(current.task+'\n最新修改：'+task,1100):task;
      const proposed=await this.ask(baseRules+' 可执行范围是整理、分析、生成文字交付物；已给齐数值时可计算工作台的机械臂轨迹或自由落体。先提出方案，不执行。输出 {"title":"题目","steps":["步骤"],"questions":["确实阻碍执行才问"],"note":"对用户说的话","operation":{"job":"arm","start":[x,y,z],"target":[x,y,z]}}。operation仅当用户给齐精确坐标并要求算轨迹才填写，缺少就不填。', {agent,task:scope,topic:room.topic,context:room.messages.slice(-8)},signal,900);
      const plan={title:cut(proposed.title,100)||'任务方案',steps:lines(proposed.steps),questions:lines(proposed.questions,4),operation:this.operation(proposed.operation,input)};
      if(!plan.steps.length&&!plan.questions.length){this.note(room,agent.id,'我还没能形成可检视的方案，可以补充交付要求吗？');return;}
      if(!current){current={id:randomUUID(),agent:agent.id,rev:0};room.tasks.push(current);if(room.tasks.length>24)room.tasks.shift();}
      Object.assign(current,{task:scope,plan,status:plan.questions.length||!plan.steps.length?'clarifying':'proposed',rev:current.rev+1,result:null});
      this.note(room,agent.id,cut(proposed.note,360)||(plan.questions.length?'我有一个需要你确认的问题。':'方案准备好了，等你确认后再执行。'));return;
    }
    if(intent.action==='ask'||intent.action==='discuss'){
      if(!room.participants.length){this.note(room,'moderator','先组织参会者，再请他们讨论。');return;}
      const panel=intent.action==='discuss'?(agent?[agent,...room.participants.filter(p=>p!==agent)].slice(0,3):room.participants.slice(0,3)):(agent?[agent]:[]);
      if(!panel.length){this.note(room,'moderator','你想问哪位参会者？');return;}
      for(const person of panel){
        const reply=await this.ask(baseRules+' 只参加讨论，给出一条简短意见或一个具体问题。输出 {"reply":"..."}。',{agent:person,topic:room.topic,question:input,otherMessages:room.messages.slice(-10),tasks:this.context(room).tasks},signal,450);
        this.note(room,person.id,cut(reply.reply,450));
      }
      return;
    }
    this.note(room,'moderator',cut(intent.reply,300)||'我可以组织 1 到 8 人的会议、按名字派活、讨论或确认方案。');
  }
  operation(value,input){
    const vec=v=>Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=10);
    const points=[...input.matchAll(/[\[（(]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[\]）)]/gu)].map(m=>m.slice(1).map(Number));
    if(!/(?:轨迹|机械臂)/.test(input)||points.length!==2||!points.every(vec)||value?.job!=='arm')return null;
    return {job:'arm',start:points[0],target:points[1]};
  }
  async approve(id,taskId,rev,signal){
    const room=this.get(id);if(room.busy)invalid('MEETING_BUSY','上一项正在进行，请稍等。',409);
    const task=room.tasks.find(t=>t.id===taskId&&t.rev===rev&&t.status==='proposed');
    if(!task)invalid('STALE_PLAN','方案已更新或不能执行，请检查最新版本。',409);
    room.busy=true;
    try{await this.execute(room,[task],signal);}finally{room.busy=false;}
    return this.snapshot(room);
  }
  async execute(room,tasks,signal){
    // At most two tasks run at once; each retains its own approved revision and result.
    const queue=tasks.slice(0,8);
    const worker=async()=>{while(queue.length&&!signal.aborted){
      const task=queue.shift();
      if(signal.aborted)break;
      task.status='running';const agent=room.participants.find(p=>p.id===task.agent);
      this.note(room,'moderator',`已确认 ${agent.name} 的《${task.plan.title}》。`);
      try{
        let computation=null;
        if(task.plan.operation){computation=await this.compute(task.plan.operation,{remote:this.remote,signal});if(computation.error)throw Error('COMPUTE_FAILED');}
        const result=await this.ask(baseRules+' 现在用户已确认方案，请按步骤真正完成任务能交付的文字内容。不要回一段泛泛计划。只输出 {"title":"...","summary":"交付摘要","deliverables":["具体内容"],"limits":["实际没有做的部分或假设"]}。如果带计算结果，使用真实数值，不编造。',{topic:room.topic,agent,task:task.task,approvedPlan:task.plan,computation:computation?{location:computation.location,duration:computation.duration,points:computation.samples?.length,end:computation.samples?.at(-1)}:null},signal,1900);
        const deliverables=lines(result.deliverables,8),summary=cut(result.summary,700);
        if(!deliverables.length&&!summary)throw Error('EMPTY_RESULT');
        task.result={title:cut(result.title,100)||task.plan.title,summary,deliverables,limits:lines(result.limits,5),computation};task.status='done';
        this.note(room,agent.id,'这项任务完成了，成果已放到结果区。');
      }catch(e){task.status='proposed';this.note(room,agent.id,e.message==='COMPUTE_FAILED'?'轨迹计算没成功。请检查目标坐标，修改方案后再确认。':'执行暂时中断，方案已保留。你可以重新确认。');}
    }};
    await Promise.all(Array.from({length:Math.min(queue.length,2)},()=>worker()));
  }
}
