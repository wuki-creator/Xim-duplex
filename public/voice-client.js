const button=document.querySelector('#voiceStart'),status=document.querySelector('#voiceStatus');
let socket,stream,context,node,source,gain,active=false,pending=false,generation=0;
function stop(text='语音已结束'){
  generation++;active=false;pending=false;
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(node){node.port.onmessage=null;node.disconnect();node=null;}
  source?.disconnect();source=null;gain?.disconnect();gain=null;
  context?.close().catch(()=>{});context=null;
  socket?.close();socket=null;
  window.speechSynthesis?.cancel();
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
    const media=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(ticket!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;
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
        source=context.createMediaStreamSource(stream);
        node=new AudioWorkletNode(context,'xim-capture');
        gain=context.createGain();gain.gain.value=0;
        node.port.onmessage=e=>{
          if(socket?.readyState===1){
            if(socket.bufferedAmount>32000){stop('网络拥塞，请重新连接语音。');return;}
            socket.send(e.data);
          }
        };
        source.connect(node);node.connect(gain);gain.connect(context.destination);
        button.textContent='结束语音';button.setAttribute('aria-pressed','true');
        status.textContent='麦克风已开启 · 可以随时插话，建议佩戴耳机';
        window.dispatchEvent(new Event('xim:voice-ready'));
      }else if(msg.type==='speech.start'){
        window.dispatchEvent(new Event('xim:speech-start'));status.textContent='正在听你说…';
      }else if(msg.type==='transcript'){
        status.textContent=msg.text?'听到了，正在回应':'没听清，可以再说一次。';
        window.dispatchEvent(new CustomEvent('xim:transcript',{detail:msg.text||''}));
      }else if(msg.type==='error')stop(msg.message);
    };
    socket.onerror=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接失败，请重试。');};
    socket.onclose=()=>{clearTimeout(timeout);if(ticket===generation)stop('语音连接已断开。');};
    stream.getTracks()[0].onended=()=>{if(ticket===generation)stop('麦克风已关闭。');};
  }catch(e){if(ticket===generation)stop(e.name==='NotAllowedError'?'没有麦克风权限。可继续使用文字对话。':'无法开启语音，请检查麦克风和本机服务。');}
};
window.addEventListener('pagehide',()=>stop());
