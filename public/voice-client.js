const button=document.querySelector('#voiceStart'),status=document.querySelector('#voiceStatus');
const diagnostics=document.querySelector('#voiceDiagnostics'),meter=document.querySelector('#micLevel'),hint=document.querySelector('#micHint'),devices=document.querySelector('#microphone'),finish=document.querySelector('#finishSpeech'),sensitivity=document.querySelector('#sensitivity'),transcript=document.querySelector('#lastTranscript');
let socket,stream,context,node,source,gain,active=false,pending=false,generation=0;
let watcher,lastPacket=0,lastSound=0,startedAt=0,speechAt=0,packets=0;
const control=data=>{if(socket?.readyState===1)socket.send(JSON.stringify(data));};
finish.onclick=()=>{control({type:'speech.finish'});finish.disabled=true;};
sensitivity.onchange=()=>control({type:'sensitivity',threshold:Number(sensitivity.value)});
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
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(node){node.port.onmessage=null;node.disconnect();node=null;}
  source?.disconnect();source=null;gain?.disconnect();gain=null;
  context?.close().catch(()=>{});context=null;
  socket?.close();socket=null;
  window.speechSynthesis?.cancel();
  window.dispatchEvent(new Event('xim:voice-closed'));
  button.textContent='开始语音';button.disabled=false;
  status.textContent=text;button.setAttribute('aria-pressed','false');
}
window.ximVoice={get active(){return active},stop};
button.onclick=async()=>{
  if(active||pending){stop();return;}
  pending=true;const ticket=++generation;button.textContent='取消连接';status.textContent='正在连接语音服务…';
  try{
    const boot=await fetch('/api/bootstrap').then(r=>r.json());if(ticket!==generation)return;
    if(!boot.asrReady){stop('本机语音服务未启动，文字对话可正常使用。');return;}
    if(!navigator.mediaDevices?.getUserMedia){stop('此浏览器无法访问麦克风。');return;}
    const media=await navigator.mediaDevices.getUserMedia({audio:{...(devices.value?{deviceId:{exact:devices.value}}:{}),channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(ticket!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;
    diagnostics.hidden=false;await listDevices().catch(()=>{});
    if(ticket!==generation)return;
    context=new AudioContext();
    await context.audioWorklet.addModule('/capture-worklet.js');
    if(ticket!==generation)return;
    await context.resume();
    socket=new WebSocket(location.origin.replace('http','ws')+'/api/voice');
    socket.binaryType='arraybuffer';
    const timeout=setTimeout(()=>{if(ticket===generation&&!active)stop('连接超时，请重试。');},7000);
    socket.onopen=()=>socket.send(JSON.stringify({token:boot.token}));
    socket.onmessage=e=>{
      if(ticket!==generation||typeof e.data!=='string')return;
      let msg;try{msg=JSON.parse(e.data);}catch{return;}
      if(msg.type==='ready'){
        clearTimeout(timeout);pending=false;active=true;
        startedAt=lastPacket=lastSound=Date.now();packets=0;
        control({type:'sensitivity',threshold:Number(sensitivity.value)});
        source=context.createMediaStreamSource(stream);
        node=new AudioWorkletNode(context,'xim-capture');
        gain=context.createGain();gain.gain.value=0;
        node.port.onmessage=e=>{
          const pcm=new Int16Array(e.data);let power=0;
          for(const v of pcm)power+=(v/32768)**2;
          const rms=Math.sqrt(power/(pcm.length||1));lastPacket=Date.now();packets++;
          if(rms>=Number(sensitivity.value))lastSound=lastPacket;
          if(packets%4===0)meter.value=Math.min(1,rms*10);
          if(socket?.readyState===1){
            if(socket.bufferedAmount>32000){stop('网络拥塞，请重新连接语音。');return;}
            socket.send(e.data);
          }
        };
        source.connect(node);node.connect(gain);gain.connect(context.destination);
        button.textContent='结束语音';button.setAttribute('aria-pressed','true');
        status.textContent='麦克风已开启 · 可以随时插话，建议佩戴耳机';
        hint.textContent='当前麦克风：'+(stream.getTracks()[0].label||'系统默认')+'。说完后停顿，或点击“这句说完了”。';
        watcher=setInterval(()=>{
          const now=Date.now();
          if(now-lastPacket>2500)hint.textContent='没有收到麦克风音频，请切换麦克风或重新连接。';
          else if(speechAt&&now-speechAt>4500)hint.textContent='如果已经说完但仍显示正在听，背景声可能阻止了断句。请点击“这句说完了”。';
          else if(!speechAt&&now-lastSound>6000&&now-startedAt>6000)hint.textContent='音量较低或没有说话。若你正在讲话，请切换麦克风或选择“轻声”。';
        },1000);
        window.dispatchEvent(new Event('xim:voice-ready'));
      }else if(msg.type==='speech.start'){
        speechAt=Date.now();finish.disabled=false;
        window.dispatchEvent(new Event('xim:speech-start'));status.textContent='正在听你说…';
      }else if(msg.type==='speech.end'){
        speechAt=0;finish.disabled=true;status.textContent='正在识别这句话…';
        hint.textContent='已收到 '+(msg.durationMs/1000).toFixed(1)+' 秒声音，等待本机中文听写结果。';
      }else if(msg.type==='no_speech'){
        hint.textContent='还没有检测到完整声音，请检查音量条并尝试“轻声”。';
      }else if(msg.type==='transcript'){
        speechAt=0;finish.disabled=true;
        status.textContent=msg.text?'听到了，正在回应':'没听清，可以再说一次。';
        if(msg.text){transcript.textContent='听到：'+msg.text;hint.textContent='麦克风持续开启，可以继续说或打断。';}
        else hint.textContent=msg.reason==='low_confidence'?'已收到声音，但中文听写结果置信度过低。请靠近麦克风、佩戴耳机再试。':'已收到声音，但本机中文听写未能识别。可以换一句短句，或使用文字。';
        window.dispatchEvent(new CustomEvent('xim:transcript',{detail:msg.text||''}));
      }else if(msg.type==='error')stop(msg.message);
    };
    socket.onerror=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接失败，请重试。');};
    socket.onclose=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接已断开。');};
    stream.getTracks()[0].onended=()=>{if(ticket===generation)stop('麦克风已关闭。');};
  }catch(e){if(ticket===generation)stop(e.name==='NotAllowedError'?'没有麦克风权限。可继续使用文字对话。':'无法开启语音，请检查麦克风和本机服务。');}
};
window.addEventListener('pagehide',()=>stop());
