const $=id=>document.getElementById(id);
const hues=['#dfb677','#9fcbac','#9bb9d7','#df9c90','#beaed0','#91c9c3','#e5cf91','#b4c3a6'];
const captions={clarifying:'待补充',proposed:'待确认',running:'正在执行',done:'已完成'};
let boot,room,selected=null,busy=false,voice=false;

function label(by){return by==='user'?'你':by==='moderator'?'伴点':room?.participants.find(p=>p.id===by)?.name||'虚拟参会者';}
function node(tag,content,className){const el=document.createElement(tag);if(className)el.className=className;if(content!==undefined)el.textContent=content;return el;}
async function request(path,payload){
  if(!boot)throw Error('本机服务还在连接。');
  const res=await fetch('/api/meeting/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bandi-Token':boot.token},body:JSON.stringify(payload)});
  const data=await res.json();if(!res.ok)throw Error(data.message||'暂时处理不了，请重试。');return data;
}
function status(text){$('meetingStatus').textContent=text;}
function speech(message){if(!voice||!message||message.by==='user'||!window.speechSynthesis)return;const say=new SpeechSynthesisUtterance((message.by==='moderator'?'':label(message.by)+'。')+message.text);say.lang='zh-CN';say.rate=.96;window.speechSynthesis.speak(say);}
function list(values,ordered=false){const result=node(ordered?'ol':'ul');for(const value of values)result.append(node('li',value));return result;}
function download(task){
  const blob=new Blob([JSON.stringify(task.result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=node('a');
  link.href=url;link.download='xim-meeting-'+task.id.slice(0,8)+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function render(){
  if(!room)return;
  const selectedPerson=room.participants.find(p=>p.id===selected);
  if(!selectedPerson)selected=null;
  $('meetingTopic').textContent=room.topic;$('seatCount').textContent=room.participants.length+' 位虚拟参会者';
  $('agentFocus').textContent=selectedPerson?'正在对 '+selectedPerson.name+' 说 · '+selectedPerson.role:'面向全体 · 点名或选择席位';
  const focusId=$('seats').contains(document.activeElement)?document.activeElement.dataset.id:null;
  $('seats').replaceChildren(...room.participants.map((p,i)=>{
    const angle=(i/room.participants.length)*Math.PI*2;
    const seat=node('button',undefined,'seat');seat.type='button';seat.dataset.id=p.id;seat.setAttribute('aria-pressed',String(p.id===selected));
    seat.style.setProperty('--x',50+Math.sin(angle)*35+'%');seat.style.setProperty('--y',50-Math.cos(angle)*37+'%');seat.style.setProperty('--person',hues[i%hues.length]);
    const person=node('span',undefined,'person');person.setAttribute('aria-hidden','true');
    seat.append(person,node('strong',p.name),node('small',p.role));seat.onclick=()=>{selected=selected===p.id?null:p.id;render();};return seat;
  }));
  if(focusId)[...$('seats').children].find(el=>el.dataset.id===focusId)?.focus();
  $('conversation').replaceChildren(...room.messages.map(m=>{
    const p=node('p');p.dataset.role=m.by==='user'?'user':'assistant';p.append(node('small',label(m.by)),document.createTextNode(m.text));return p;
  }));
  $('conversation').scrollTop=$('conversation').scrollHeight;
  $('taskCount').textContent=room.tasks.length+' 项';
  $('tasks').replaceChildren(...(room.tasks.length?room.tasks.map(task=>{
    const card=node('article',undefined,'task-card'),meta=node('div',undefined,'task-meta');
    meta.append(node('span',label(task.agent)+' · 第 '+task.rev+' 版'),node('span',captions[task.status]||task.status));
    card.append(meta,node('h3',task.plan.title),node('p',task.task));
    if(task.plan.steps.length)card.append(list(task.plan.steps,true));
    if(task.plan.questions.length){card.append(node('p','需要补充：'),list(task.plan.questions));const revise=node('button','答复 '+label(task.agent));revise.type='button';revise.onclick=()=>{
      selected=task.agent;render();$('meetingText').focus();
    };card.append(revise);}
    if(task.status==='proposed'){const confirm=node('button','确认执行');confirm.type='button';confirm.disabled=busy;confirm.onclick=()=>perform('approve',{task:task.id,rev:task.rev},'正在执行已确认的方案…');card.append(confirm);}
    return card;
  }):[node('p','给一位参会者派活后，这里会出现方案。','task-empty')]));
  const complete=room.tasks.filter(t=>t.status==='done'&&t.result);
  $('resultCount').textContent=complete.length+' 份成果';
  $('meetingResults').replaceChildren(...(complete.length?complete.map(task=>{
    const box=node('article',undefined,'task-card'),{result}=task;
    box.append(node('div',label(task.agent)+' · 已完成','task-meta'),node('h3',result.title),node('p',result.summary));
    if(result.deliverables.length)box.append(list(result.deliverables));
    if(result.computation)box.append(node('p','轨迹结果 · '+result.computation.samples.length+' 点 · '+(result.computation.location==='server'?'服务器':'本机')));
    if(result.limits.length)box.append(node('p','假设与边界：'),list(result.limits));
    const btn=node('button','下载成果');btn.type='button';btn.onclick=()=>download(task);box.append(btn);return box;
  }):[node('p','确认并执行方案后，成果会显示在这里。','task-empty')]));
  $('meetingSend').disabled=busy;$('organizeButton').disabled=busy;
}

async function perform(path,payload,pending){
  if(busy){status('上一条正在处理，请稍等。');return;}
  if(!room){status('会议空间仍在连接。');return;}
  busy=true;status(pending);render();
  const last=room.messages.at(-1);
  try{
    room=await request(path,{id:room.id,...payload});status('');
    const message=room.messages.at(-1);if(message&&(message.text!==last?.text||message.by!==last?.by))speech(message);
  }catch(e){status(e.message);}finally{busy=false;render();}
}
function submit(value){const text=value.trim().slice(0,1000);if(text)void perform('input',{text,selected},'伴点正在处理你的话…');}
$('meetingCommand').onsubmit=e=>{e.preventDefault();if(busy)return;const text=$('meetingText').value;$('meetingText').value='';submit(text);};
$('organize').onsubmit=e=>{e.preventDefault();const topic=$('topicText').value.trim();submit('组织'+$('members').value+'个人开会'+(topic?'，主题：'+topic:''));};
window.addEventListener('xim:transcript',e=>{if(typeof e.detail==='string')submit(e.detail);});
window.addEventListener('xim:voice-ready',()=>{voice=true;});
window.addEventListener('xim:voice-closed',()=>{voice=false;});
window.addEventListener('xim:speech-start',()=>window.speechSynthesis?.cancel());
status('正在连接会议空间…');
fetch('/api/bootstrap').then(r=>{if(!r.ok)throw Error();return r.json();}).then(async x=>{
  boot=x;
  const id=new URLSearchParams(location.search).get('room');
  room=id?await request('snapshot',{id}):await request('create',{});
  history.replaceState(null,'','/meeting.html');status('');render();
}).catch(()=>status('连不上本机会议服务，或这场会议已过期。请重新打开。'));
