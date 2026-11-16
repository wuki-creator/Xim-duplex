import {LivePlayer} from './live-player.js';
import {LiveTurns} from './live-turns.js';
const button=document.querySelector('#voiceStart'),status=document.querySelector('#voiceStatus');
const el=(id,tag)=>document.getElementById(id)||document.createElement(tag);
const compact=button.dataset.mode==='live';
const continueTurn=el('continueTurn','button'),liveTurns=new LiveTurns();
const options=el('voiceOptions','label'),modeSelect=el('voiceMode','select'),privacy=el('voicePrivacy','p');
const diagnostics=el('voiceDiagnostics','div'),meter=el('micLevel','meter'),hint=el('micHint','p'),devices=el('microphone','select'),finish=el('finishSpeech','button'),sensitivity=el('sensitivity','select'),transcript=el('lastTranscript','p');
const sensitivityLabel=sensitivity.closest('label')||document.createElement('label');
const threshold=()=>Number(sensitivity.value)||.012;
const buttonLabel=text=>{(compact?button.querySelector('strong'):button).textContent=text;};
let socket,stream,context,node,source,gain,player,route='cascade',active=false,pending=false,generation=0;
let watcher,lastPacket=0,lastSound=0,startedAt=0,speechAt=0,packets=0;
let liveWatch,handoff,voiceBoot;
const control=data=>{if(socket?.readyState===1)socket.send(JSON.stringify(data));};
function voiceOptions(boot){
  options.hidden=!boot.voiceLive;
  modeSelect.disabled=active||pending;
  privacy.hidden=!(modeSelect.value==='live'||boot.cloudAsr);
  privacy.textContent=modeSelect.value==='live'?'实时语音会将麦克风音频发送给模思；没有及时接话时可用基础语音接续。':'当前基础语音的转写由模思处理。';
  modeSelect.onchange=()=>voiceOptions(boot);
}
window.addEventListener('xim:bootstrap',e=>voiceOptions(e.detail));
if(window.ximChat?.voiceSettings)voiceOptions(window.ximChat.voiceSettings);
function setupCascade(){
  finish.hidden=false;sensitivityLabel.hidden=false;
  control({type:'sensitivity',threshold:threshold()});
}
function assist(automatic=false){
  if(route!=='live'||!active||!voiceBoot?.configured||handoff||player?.playing)return;
  if(automatic&&Date.now()-lastSound<180)return;
  const turn=liveTurns.take(performance.now(),{automatic});if(!turn)return;
  continueTurn.hidden=true;
  const deliver=()=>window.dispatchEvent(new CustomEvent('xim:live-recover',{detail:turn}));
  if(!voiceBoot.asrReady){stop('实时语音暂未接话，先为你回答这句。');deliver();return;}
  player?.close();player=null;clearInterval(liveWatch);liveWatch=null;
  route='cascade';modeSelect.value='cascade';voiceOptions(voiceBoot);
  status.textContent='实时语音未及时回应，正在接续这句…';
  const timer=setTimeout(()=>{stop('实时语音未及时回应，先为你回答这句。');deliver();},2500);
  handoff={timer,deliver};control({type:'live.fallback'});
}
continueTurn.onclick=()=>assist();
function trackLiveWait(){
  const now=performance.now(),wait=liveTurns.waiting(now);
  continueTurn.hidden=!(voiceBoot?.configured&&wait?.elapsed>=2800&&!player?.playing);
  const update=text=>{if(status.textContent!==text)status.textContent=text;};
  if(wait?.elapsed>=2800&&!player?.playing)update(wait.recoverable?'已经听清，正在等伴点接话…':'麦克风仍开启 · 可以继续说');
  if(wait?.recoverable&&wait.elapsed>=6500)assist(true);
  if(liveTurns.stoppedAt!==null&&now-liveTurns.stoppedAt>3500&&!liveTurns.current?.text&&!player?.playing){
    update('这一句还没听清，可以再说一次。');
  }
}
finish.onclick=()=>{control({type:'speech.finish'});finish.disabled=true;};
sensitivity.onchange=()=>control({type:'sensitivity',threshold:threshold()});
devices.onchange=()=>{if(active||pending){stop('正在切换麦克风…');button.click();}};
async function listDevices(){
  const selected=devices.value;
  const available=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
  devices.replaceChildren(new Option('系统默认',''));
  for(const d of available)devices.add(new Option(d.label||'麦克风 '+devices.options.length,d.deviceId));
  if([...devices.options].some(o=>o.value===selected))devices.value=selected;
}
function stop(text='语音已结束'){
  generation++;active=false;pending=false;
  clearInterval(watcher);watcher=null;finish.disabled=true;meter.value=0;speechAt=0;
  clearInterval(liveWatch);liveWatch=null;clearTimeout(handoff?.timer);handoff=null;liveTurns.clear();continueTurn.hidden=true;
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(node){node.port.onmessage=null;node.disconnect();node=null;}
  source?.disconnect();source=null;gain?.disconnect();gain=null;
  player?.close();player=null;modeSelect.disabled=false;
  context?.close().catch(()=>{});context=null;
  socket?.close();socket=null;
  window.speechSynthesis?.cancel();
  window.dispatchEvent(new Event('xim:voice-closed'));
  buttonLabel(compact?'实时语音':'开始语音');button.disabled=false;delete button.dataset.connecting;
  if(compact&&!['语音已结束','已开始新对话，语音已关闭。','已结束实时语音，继续文字对话。'].includes(text))window.ximChat?.note(text);
  status.textContent=text;button.setAttribute('aria-pressed','false');
}
window.ximVoice={get active(){return active},get live(){return (active||pending)&&route==='live'},stop,mute:muted=>player?.mute(muted)};
button.onclick=async()=>{
  if(active||pending){stop();return;}
  pending=true;route=button.dataset.mode||modeSelect.value||'cascade';modeSelect.disabled=true;const ticket=++generation;buttonLabel(compact?'连接中…':'取消连接');button.dataset.connecting='';status.textContent='正在连接语音服务…';window.ximChat?.note('');
  try{
    const boot=await fetch('/api/bootstrap').then(r=>r.json());if(ticket!==generation)return;
    voiceBoot=boot;
    if(route==='live'&&!boot.voiceLive){stop('实时语音尚未配置，请选择基础语音。');return;}
    if(route!=='live'&&!boot.asrReady){stop('基础语音服务未启动，文字对话可正常使用。');return;}
    if(!navigator.mediaDevices?.getUserMedia){stop('此浏览器无法访问麦克风。');return;}
    const media=await navigator.mediaDevices.getUserMedia({audio:{...(devices.value?{deviceId:{exact:devices.value}}:{}),channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(ticket!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;
    diagnostics.hidden=false;if(!compact)await listDevices().catch(()=>{});
    if(ticket!==generation)return;
    context=new AudioContext();
    await context.audioWorklet.addModule('/capture-worklet.js');
    if(ticket!==generation)return;
    await context.resume();
    socket=new WebSocket(location.origin.replace('http','ws')+'/api/voice');
    socket.binaryType='arraybuffer';
    const timeout=setTimeout(()=>{if(ticket===generation&&!active)stop('语音连接超时，可重试或切换语音模式。');},route==='live'?14000:7000);
    socket.onopen=()=>socket.send(JSON.stringify({token:boot.token,mode:route}));
    socket.onmessage=e=>{
      if(ticket!==generation)return;
      if(typeof e.data!=='string'){
        try{
          const audio=player?.speakFrame(e.data);
          if(audio){liveTurns.audio(audio);continueTurn.hidden=true;status.textContent='伴点在说 · 你也可以开口';}
        }catch{stop('实时音频无法播放。请重试或切回基础语音。');}return;
      }
      let msg;try{msg=JSON.parse(e.data);}catch{return;}
      if(msg.type==='ready'){
        clearTimeout(timeout);pending=false;active=true;
        startedAt=lastPacket=lastSound=Date.now();packets=0;
        const live=msg.mode==='live';
        finish.hidden=live;sensitivityLabel.hidden=live;
        transcript.textContent='';
        if(live){
          liveTurns.clear();liveWatch=setInterval(trackLiveWait,250);
          player=new LivePlayer(context,value=>{
            control(value);
            if(value.action==='playback.completed')window.dispatchEvent(new CustomEvent('xim:live-played',{detail:value}));
          });
        }else setupCascade();
        source=context.createMediaStreamSource(stream);
        node=new AudioWorkletNode(context,'xim-capture');
        gain=context.createGain();gain.gain.value=0;
        node.port.onmessage=e=>{
          const pcm=new Int16Array(e.data);let power=0;
          for(const v of pcm)power+=(v/32768)**2;
          const rms=Math.sqrt(power/(pcm.length||1));lastPacket=Date.now();packets++;
          if(rms>=threshold())lastSound=lastPacket;
          if(packets%4===0)meter.value=Math.min(1,rms*10);
          if(socket?.readyState===1){
            if(socket.bufferedAmount>32000){stop('网络拥塞，请重新连接语音。');return;}
            socket.send(e.data);
          }
        };
        source.connect(node);node.connect(gain);gain.connect(context.destination);
        buttonLabel(compact?'实时语音':'结束语音');delete button.dataset.connecting;button.setAttribute('aria-pressed','true');
        status.textContent=live?'实时语音已开启 · 可以自然接话':'麦克风已开启 · 可以随时插话，建议佩戴耳机';
        hint.textContent='当前麦克风：'+(stream.getTracks()[0].label||'系统默认')+(live?'。建议佩戴耳机。':'。说完后停顿，或点击“这句说完了”。');
        watcher=setInterval(()=>{
          const now=Date.now();
          if(now-lastPacket>2500)hint.textContent='没有收到麦克风音频，请切换麦克风或重新连接。';
          else if(route!=='live'&&speechAt&&now-speechAt>4500)hint.textContent='如果已经说完但仍显示正在听，背景声可能阻止了断句。请点击“这句说完了”。';
          else if(!speechAt&&now-lastSound>6000&&now-startedAt>6000)hint.textContent=route==='live'?'若你正在讲话但音量很低，可切换麦克风。':'音量较低或没有说话。若你正在讲话，请切换麦克风或选择“轻声”。';
        },1000);
        window.dispatchEvent(new Event('xim:voice-ready'));
      }else if(msg.type==='live.chunk'&&player){player.pending=msg.data;
      }else if(msg.type==='live.event'&&player){
        const {action,data}=msg;const now=performance.now();let group;
        try{player.event(action,data);}catch{stop('实时音频无法播放。请重试或切回基础语音。');return;}
        if(action==='input.speech.started'){liveTurns.start();continueTurn.hidden=true;speechAt=Date.now();status.textContent='正在听你说…';}
        if(action==='input.speech.stopped'){liveTurns.stop(now);speechAt=0;status.textContent='等伴点接话…';}
        if(action==='input.transcript.done'||action==='input.transcript.revised')group=liveTurns.confirm(data,now,action==='input.transcript.revised');
        if(action==='input.transcript.updated'||action==='input.transcript.done')transcript.textContent=data.text?'听到：'+data.text:'';
        if(action==='response.audio.started')liveTurns.associate(data);
        if(action==='response.audio.stop'||action==='response.interrupted')status.textContent=speechAt?'已让你先说':'麦克风已开启 · 可以继续聊';
        if(action==='response.ended'&&data.status==='completed')status.textContent='实时语音已开启 · 可以继续聊';
        window.dispatchEvent(new CustomEvent('xim:live-event',{detail:{action,data,group}}));
      }else if(msg.type==='fallback.ready'&&handoff){
        const {timer,deliver}=handoff;clearTimeout(timer);handoff=null;speechAt=0;
        setupCascade();status.textContent='基础语音已接上 · 麦克风保持开启';
        hint.textContent='已用你刚说的话继续回应，无需重说。';deliver();
      }else if(msg.type==='speech.start'){
        speechAt=Date.now();finish.disabled=false;
        window.dispatchEvent(new Event('xim:speech-start'));status.textContent='正在听你说…';
      }else if(msg.type==='speech.end'){
        speechAt=0;finish.disabled=true;status.textContent='正在识别这句话…';
        hint.textContent='已收到 '+(msg.durationMs/1000).toFixed(1)+' 秒声音，正在转成文字。';
      }else if(msg.type==='no_speech'){
        hint.textContent='还没有检测到完整声音，请检查音量条并尝试“轻声”。';
      }else if(msg.type==='transcript'){
        speechAt=0;finish.disabled=true;
        status.textContent=msg.text?'听到了，正在回应':'没听清，可以再说一次。';
        if(msg.text){transcript.textContent='听到：'+msg.text;hint.textContent='麦克风持续开启，可以继续说或打断。';}
        else hint.textContent=msg.reason==='overlap'?'听到不止一个人。请你单独再说一次。':msg.reason==='low_confidence'?'已收到声音，但识别结果置信度过低。请靠近麦克风、佩戴耳机再试。':'已收到声音，但语音服务未能识别。可以换一句短句，或使用文字。';
        window.dispatchEvent(new CustomEvent('xim:transcript',{detail:msg.text||''}));
      }else if(msg.type==='error')stop(msg.message);
    };
    socket.onerror=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接失败，请重试。');};
    socket.onclose=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接已断开。');};
    stream.getTracks()[0].onended=()=>{if(ticket===generation)stop('麦克风已关闭。');};
  }catch(e){if(ticket===generation)stop(e.name==='NotAllowedError'?'没有麦克风权限。可继续使用文字对话。':'无法开启语音，请检查麦克风和本机服务。');}
};
window.addEventListener('pagehide',()=>stop());
