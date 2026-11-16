import {DialogueState,speechChunks} from './dialogue-state.js';
const dialogue=new DialogueState();
const $ = id => document.getElementById(id);
const messages = $('messages'), input = $('input'), pet = $('pet');
const starters = [...document.querySelectorAll('[data-prompt]')];
const moods = [...document.querySelectorAll('[data-mood]')];
const labels = {
  joy:['开心','#f4d18a'], warm:['温暖','#f3c7a3'], calm:['平静','#bfe5c8'],
  curious:['好奇','#e0cafa'], support:['陪伴','#bfddfa'], celebrate:['庆祝','#f9c7df'],
};
const messagesForErrors = {
  MODEL_NO_REPLY:'这次没收到伴点的回复。可以重试，或换个说法。',
  MODEL_UNAVAILABLE:'暂时连不上对话服务。请稍后重试。',
  MODEL_ACCESS:'对话服务暂不可用，请检查模型配置。',
  MODEL_NOT_CONFIGURED:'对话服务尚未配置。请先在本机配置模型连接。',
  MODEL_FILTERED:'这次没有可显示的回复。可以换个话题。',
  MODEL_TIMEOUT:'等得有点久，伴点没接上。可以重试。',
  TOO_MANY_REQUESTS:'消息发得有点快，等一会儿再试。',
  ACCESS_DENIED:'连接已更新。请刷新页面后再发一次。',
  INVALID_INPUT:'请输入 1 到 2000 字的消息。',
};
let boot, active = null, retryable = null, voice = false, playback=null, playbackEpoch=0;
let speechContext;
const prosody={joy:[1.02,1.06],warm:[.96,1],calm:[.9,.96],curious:[.98,1.03],support:[.92,.98],celebrate:[1.04,1.08]};

function cancelPlayback(reason='user_speech'){
  playbackEpoch++;
  if(playback){
    playback.controller?.abort();
    try{playback.source?.stop();}catch{}
    dialogue.interrupt(playback.node,reason);
    playback.label.textContent='伴点 · 已暂停朗读';
    playback=null;
  }
  window.speechSynthesis?.cancel();
}
function speak(node,answer,reply){
  const cloud=Boolean(boot?.cloudTts&&speechContext?.state==='running');
  const epoch=++playbackEpoch,chunks=speechChunks(node.reply,cloud?72:36),controller=new AbortController();
  let cloudFailed=false;
  playback={node,label:answer.querySelector('small'),controller};
  const next=async index=>{
    if(epoch!==playbackEpoch)return;
    const chunk=chunks[index];
    if(!chunk){playback=null;return;}
    if(!chunk.text.trim()){dialogue.acknowledge(node,chunk.end);void next(index+1);return;}
    if(cloud&&!cloudFailed){
      try{
        const res=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json','X-Bandi-Token':boot.token},body:JSON.stringify({id:reply.id,offset:chunk.start,end:chunk.end}),signal:controller.signal});
        if(!res.ok)throw Error('Speech unavailable');
        const buffer=await speechContext.decodeAudioData(await res.arrayBuffer());
        if(epoch!==playbackEpoch)return;
        const source=speechContext.createBufferSource();source.buffer=buffer;source.connect(speechContext.destination);playback.source=source;
        source.onended=()=>{source.disconnect();if(epoch===playbackEpoch){dialogue.acknowledge(node,chunk.end);void next(index+1);}};
        source.start();return;
      }catch{if(epoch!==playbackEpoch)return;cloudFailed=true;}
    }
    if(!window.speechSynthesis){cancelPlayback('playback_error');note('语音暂时不可用，文字回复已保留。');return;}
    let offset=0,emotion='warm';
    for(const seg of reply.segments){offset+=seg.text.length+1;if(chunk.start<offset){emotion=seg.emotion;break;}}
    const utterance=new SpeechSynthesisUtterance(chunk.text);utterance.lang='zh-CN';
    [utterance.rate,utterance.pitch]=prosody[emotion]||prosody.warm;
    utterance.onboundary=event=>{if(epoch===playbackEpoch)dialogue.acknowledge(node,chunk.start+event.charIndex);};
    utterance.onend=()=>{if(epoch===playbackEpoch){dialogue.acknowledge(node,chunk.end);next(index+1);}};
    utterance.onerror=()=>{if(epoch===playbackEpoch){cancelPlayback('playback_error');note('朗读中断，文字回复已保留。');}};
    window.speechSynthesis.speak(utterance);
  };
  next(0);
}

const note = (text='') => { $('error').textContent = text; };
const subtitle = text => { $('subtitle').textContent = text; };
let lastSubtitle = $('subtitle').textContent;

function mood(value) {
  const e=Object.hasOwn(labels,value)?value:'warm';
  pet.className='robot '+e;
  for(const b of moods) b.setAttribute('aria-pressed',String(b.dataset.mood===e));
  $('emotion').textContent=labels[e][0];
  document.documentElement.style.setProperty('--accent',labels[e][1]);
}
const nearBottom=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<54;
let following=true;
const updateJump=()=>{ $('jumpLatest').hidden=nearBottom(); };
const jump=()=>{ following=true;messages.scrollTop=messages.scrollHeight;updateJump(); };
$('jumpLatest').onclick=jump;
messages.addEventListener('scroll',()=>{
  if(!messages.clientHeight)return;
  following=nearBottom();updateJump();
},{passive:true});
new ResizeObserver(()=>{
  if(!messages.clientHeight)return;
  if(following)jump();else updateJump();
}).observe(messages);

function append(card, force=false) {
  const follow=force||nearBottom();
  messages.append(card);
  while(messages.childElementCount>60) messages.firstElementChild.remove();
  if(follow) jump(); else updateJump();
}
function card(role,label,text) {
  const a=document.createElement('article'), tag=document.createElement('small');
  a.className=role; tag.textContent=label; a.append(tag);
  if(text) {
    const p=document.createElement('p');p.textContent=text;a.append(p);
  }
  return a;
}
async function post(route,data,signal) {
  const r=await fetch('/api/'+route,{
    method:'POST',signal,
    headers:{'Content-Type':'application/json','X-Bandi-Token':boot.token},
    body:JSON.stringify(data),
  });
  const payload=await r.json().catch(()=>null);
  if(!r.ok||!payload) throw Error(payload?.error||'MODEL_UNAVAILABLE');
  return payload;
}
function busy(value) {
  $('send').hidden=value; $('stop').hidden=!value;
  for (const b of starters) b.disabled=value;
  $('state').textContent=value?'正在回应':'我在这里';
  if(value) {
    pet.dataset.activity='thinking';
    subtitle('伴点正在想怎么回你…');
  } else {
    delete pet.dataset.activity;
    subtitle(lastSubtitle);
  }
}
function dismissRetry() {
  retryable?.retry?.remove();
  retryable=null;
}
function failed(turn,label,mayRetry=true) {
  turn.status ??= document.createElement('div');
  turn.status.className='turn-status'; turn.status.textContent=label; turn.user.append(turn.status);
  if(mayRetry) {
    const retry=document.createElement('button');
    retry.type='button'; retry.textContent='重试'; retry.className='retry-turn';
    retry.onclick=()=>{ if(!active) run(turn); };
    turn.retry=retry; retryable=turn; turn.user.append(retry);
  }
}
function stop(mark=false) {
  if(active) {
    const turn=active; active=null;dialogue.interrupt(turn.node); turn.controller.abort(); turn.pending.remove();
    if(mark) failed(turn,'已停止');
  }
  cancelPlayback();
  busy(false);
}
function renderReply(reply) {
  const e=Object.hasOwn(labels,reply.segments[0]?.emotion)?reply.segments[0].emotion:'warm';
  const a=card('assistant','伴点 · '+labels[e][0]);
  for(const seg of reply.segments) {
    const p=document.createElement('p'); p.className='segment';
    p.style.setProperty('--tone',(labels[seg.emotion]||labels.warm)[1]);
    p.textContent=seg.text; a.append(p);
  }
  const feedback=document.createElement('div');
  feedback.className='feedback-buttons';
  for(const [rating,title] of [['helpful','有帮助'],['unhelpful','不合适']]) {
    const b=document.createElement('button');b.textContent=title;
    b.onclick=async()=>{
      if(!$('feedbackConsent').checked){note('先勾选输入框下的改进授权，再提交评价。');return;}
      const buttons=[...feedback.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);
      try{
        await post('feedback',{id:reply.id,rating,consent:true});
        feedback.textContent='谢谢你的反馈，已保存。';
      }catch{buttons.forEach(x=>x.disabled=false);note('反馈未保存，可能已提交或过期。');}
    };
    feedback.append(b);
  }
  a.append(feedback);
  mood(e);
  lastSubtitle=reply.segments[0].text;
  return a;
}
async function run(turn) {
  if(active || !boot) return;
  dismissRetry();
  turn.status?.remove();
  const {text}=turn;
  note();cancelPlayback('new_message');
  turn.node??=dialogue.begin(text);
  turn.node.status='generating';
  const pending=card('assistant pending','伴点','正在回应');
  const controller=new AbortController();
  turn.controller=controller; turn.pending=pending; active=turn;
  append(pending,true);
  busy(true);
  try {
    const reply=await post('chat',{...dialogue.request(turn.node),style:'warm'},controller.signal);
    if(active!==turn || controller.signal.aborted) return;
    const follow=nearBottom();
    const answer=renderReply(reply);
    pending.replaceWith(answer);
    if(follow) jump();else updateJump();
    const replyText=reply.segments.map(s=>s.text).join('\n');
    const spoken=Boolean(voice&&(window.speechSynthesis||(boot.cloudTts&&speechContext?.state==='running')));
    dialogue.complete(turn.node,replyText,spoken);
    if(input.value.trim()===text) input.value='';
    if(spoken)speak(turn.node,answer,reply);
  } catch(e) {
    if(active!==turn || controller.signal.aborted) return;
    pending.remove();
    const filtered=e.message==='MODEL_FILTERED';
    failed(turn,filtered?'未显示回复':'未收到回复',!filtered);
    if(!input.value.trim()) input.value=text;
    note(messagesForErrors[e.message]||'网络连接中断，你的消息还在。可以重试。');
    updateJump();
  } finally {
    if(active===turn && turn.controller===controller) {active=null;busy(false);}
  }
}
function send(text) {
  if(active || !text) return;
  if(!boot){note('还没连上伴点，请稍后再试。');return;}
  if(text.length>2000){note(messagesForErrors.INVALID_INPUT);return;}
  if(window.ximVoice?.live)window.ximVoice.stop('已结束实时语音，继续文字对话。');
  if(retryable?.text===text){run(retryable);return;}
  const user=card('user','你',text);
  append(user,true);run({text,user});
}
$('chatForm').onsubmit=e=>{e.preventDefault();send(input.value.trim());};
input.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){
    e.preventDefault();if(!active && input.value.trim())$('chatForm').requestSubmit();
  }
});
for(const b of starters) b.onclick=()=>{ if(!active){input.value=b.dataset.prompt;send(input.value);} };
$('stop').onclick=()=>{stop(true);note('已停止本轮回复。');};
$('mute').onclick=()=>{
  voice=!voice;$('mute').textContent=voice?'声音开启':'声音关闭';
  window.ximVoice?.mute(!voice);
  if(voice)prepareSpeech();
  $('mute').setAttribute('aria-pressed',String(voice));if(!voice)cancelPlayback('muted');
};
function prepareSpeech(){
  if(!boot?.cloudTts||!window.AudioContext)return;
  try{speechContext??=new AudioContext();speechContext.resume().catch(()=>{});}catch{}
}
for(const b of moods) b.onclick=()=>mood(b.dataset.mood);
pet.onclick=()=>{mood('joy');$('touch').textContent='收到摸摸头，伴点也跟你打招呼。';};
$('color').onchange=()=>document.body.classList.toggle('no-color',!$('color').checked);
$('motion').onchange=()=>document.body.classList.toggle('no-motion',!$('motion').checked);
$('clear').onclick=()=>{
  window.ximVoice?.stop('已开始新对话，语音已关闭。');
  stop();dismissRetry();dialogue.clear();resetLiveLog();input.value='';
  lastSubtitle='我们从这里重新开始吧。';subtitle(lastSubtitle);
  messages.replaceChildren(card('assistant','伴点',lastSubtitle));mood('warm');
  note('对话已清空。');
};
fetch('/api/bootstrap').then(r=>{
  if(!r.ok)throw Error('bootstrap failed');return r.json();
}).then(x=>{
  boot=x;
  if(!x.configured)note('对话服务尚未配置，请先连接模型。');
  window.dispatchEvent(new CustomEvent('xim:bootstrap',{detail:x}));
}).catch(()=>{note('无法连接本机服务，请重新打开伴点。');});


window.ximChat={send,stop:()=>stop(true),note,subtitle,mood,get token(){return boot?.token},get voiceSettings(){return boot&&{voiceLive:boot.voiceLive,cloudAsr:boot.cloudAsr}},get busy(){return Boolean(active)},get speaking(){return Boolean(window.speechSynthesis?.speaking)}};
const filmDialog=document.querySelector('#filmDialog');
document.querySelector('#filmOpen').onclick=()=>filmDialog.showModal();
document.querySelector('#filmClose').onclick=()=>filmDialog.close();
filmDialog.addEventListener('close',()=>filmDialog.querySelector('video').pause());
filmDialog.addEventListener('cancel',()=>filmDialog.querySelector('video').pause());
window.addEventListener('xim:speech-start',()=>{if(active||playback)stop(true);});
const liveUsers=new Map(),liveReplies=new Map(),livePlayed=new Set(),liveEntries=new Set();
const audioKey=d=>JSON.stringify([d.run_id,d.turn_id]);
function resetLiveLog(){liveUsers.clear();liveReplies.clear();livePlayed.clear();liveEntries.clear();}
window.addEventListener('xim:voice-closed',()=>{
  cancelPlayback('voice_closed');
  $('state').textContent='我在这里';delete pet.dataset.activity;
});
window.addEventListener('xim:transcript',e=>{if(e.detail.trim())send(e.detail.trim());});
window.addEventListener('xim:voice-ready',()=>{
  if(window.ximVoice?.live){stop(true);resetLiveLog();}
  else prepareSpeech();
  voice=true;$('mute').textContent='声音开启';$('mute').setAttribute('aria-pressed','true');
});
const trimCards=map=>{for(const [key,entry] of map)if(!entry.isConnected)map.delete(key);};
function rememberLive(entry){for(const item of liveEntries)if(!item.isConnected)liveEntries.delete(item);liveEntries.add(entry);}
window.addEventListener('xim:live-played',({detail:data})=>{
  const id=audioKey(data);livePlayed.add(id);
  if(livePlayed.size>100)livePlayed.delete(livePlayed.values().next().value);
  const entry=liveReplies.get(id);if(entry)entry.dataset.liveHeard='';
});
window.addEventListener('xim:live-recover',({detail:{id,text}})=>{
  if(!boot||active)return;
  const user=liveUsers.get(id);if(!user?.isConnected)return;
  let node;
  for(const entry of messages.children){
    if(entry===user)break;
    if(!liveEntries.has(entry))continue;
    const line=entry.querySelector('p')?.textContent?.trim();if(!line)continue;
    if(entry.classList.contains('user'))node=dialogue.begin(line);
    else if(node&&entry.hasAttribute('data-live-heard'))dialogue.complete(node,[node.reply,line].filter(Boolean).join(' ').slice(0,2000),false);
  }
  resetLiveLog();prepareSpeech();run({text,user});
});
window.addEventListener('xim:live-event',({detail:{action,data,group}})=>{
  const {text}=data;
  if(action==='input.speech.started'){$('state').textContent='正在听';return;}
  if(action==='response.audio.started'){$('state').textContent='伴点在说';return;}
  if(action==='response.ended'){$('state').textContent='我在这里';}
  if(action==='input.transcript.done'||action==='input.transcript.revised'){
    if(!group)return;
    const old=liveUsers.get(group.id);
    if(old?.isConnected){old.querySelector('p').textContent=group.text;return;}
    const entry=card('user','你',group.text);append(entry);rememberLive(entry);
    liveUsers.set(group.id,entry);trimCards(liveUsers);return;
  }
  const id=audioKey(data);
  const interrupted=action==='response.interrupted';
  if(action==='response.audio.stop'||(action==='response.ended'&&data.status!=='completed')){
    const entry=liveReplies.get(id);if(entry){entry.dataset.stopped='';entry.querySelector('small').textContent='伴点 · 已停播';}
    if(action==='response.audio.stop'){$('state').textContent='正在听';subtitle('你先说，我在听。');}
    return;
  }
  if(!['output.transcript.updated','output.transcript.done','response.interrupted'].includes(action))return;
  let entry=liveReplies.get(id);
  if(entry?.hasAttribute('data-stopped')&&!interrupted)return;
  if(!entry){if(!text)return;entry=card('assistant','伴点',text);liveReplies.set(id,entry);append(entry);rememberLive(entry);trimCards(liveReplies);if(livePlayed.has(id))entry.dataset.liveHeard='';}
  const p=entry.querySelector('p');p.textContent=text||'';
  if(interrupted){entry.dataset.stopped='';if(text)entry.dataset.liveHeard='';entry.querySelector('small').textContent='伴点 · 已让你先说';lastSubtitle=text||'你先说，我在听。';subtitle(lastSubtitle);}
  else if(text){lastSubtitle=text;subtitle(text);}
});
