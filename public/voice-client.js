// Xim audio ingress. Playback and cancellation are owned by each workspace.
const button=document.querySelector('#voiceStart'),status=document.querySelector('#voiceStatus');
const compact=button.classList.contains('live-toggle');
const buttonLabel=text=>{(compact?button.querySelector('strong'):button).textContent=text;};
let socket,stream,context,node,source,gain,active=false,pending=false,generation=0,timeout,watcher;
let lastPacket=0,frames=0;
function stop(text='语音已结束'){
  generation++;active=false;pending=false;clearTimeout(timeout);clearInterval(watcher);
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(node){node.port.onmessage=null;node.disconnect();node=null;}
  source?.disconnect();source=null;gain?.disconnect();gain=null;
  context?.close().catch(()=>{});context=null;socket?.close();socket=null;
  window.speechSynthesis?.cancel();window.dispatchEvent(new Event('xim:voice-closed'));
  buttonLabel(compact?'实时语音':'开始语音');button.disabled=false;delete button.dataset.connecting;
  status.textContent=text;button.setAttribute('aria-pressed','false');
  if(compact&&!['语音已结束','已开始新对话，语音已关闭。','已结束实时语音，继续文字对话。'].includes(text))window.ximChat?.note(text);
}
window.ximVoice={get active(){return active},stop};
button.onclick=async()=>{
  if(active||pending){stop();return;}
  pending=true;const ticket=++generation;
  buttonLabel(compact?'连接中…':'取消连接');button.dataset.connecting='';
  status.textContent='正在连接语音服务…';window.ximChat?.note('');
  try{
    const boot=await fetch('/api/bootstrap').then(r=>r.json());if(ticket!==generation)return;
    if(!boot.asrReady){stop('语音识别服务未连接，文字对话仍可使用。');return;}
    if(!navigator.mediaDevices?.getUserMedia){stop('此浏览器无法访问麦克风。');return;}
    const media=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(ticket!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;context=new AudioContext();
    await context.audioWorklet.addModule('/capture-worklet.js');if(ticket!==generation)return;
    await context.resume();if(ticket!==generation)return;
    socket=new WebSocket(location.origin.replace('http','ws')+'/api/voice');socket.binaryType='arraybuffer';
    timeout=setTimeout(()=>{if(ticket===generation&&!active)stop('语音连接超时，请重试。');},7000);
    socket.onopen=()=>socket.send(JSON.stringify({token:boot.token,mode:'cascade'}));
    socket.onmessage=e=>{
      if(ticket!==generation||typeof e.data!=='string')return;
      let msg;try{msg=JSON.parse(e.data);}catch{return;}
      if(msg.type==='ready'){
        clearTimeout(timeout);pending=false;active=true;lastPacket=Date.now();frames=0;
        source=context.createMediaStreamSource(stream);node=new AudioWorkletNode(context,'xim-capture');
        gain=context.createGain();gain.gain.value=0;
        node.port.onmessage=e=>{
          if(ticket!==generation)return;lastPacket=Date.now();frames++;
          if(socket?.readyState===1){
            if(socket.bufferedAmount>32000){stop('网络拥塞，请重新连接语音。');return;}
            socket.send(e.data);
          }
        };
        source.connect(node);node.connect(gain);gain.connect(context.destination);
        buttonLabel(compact?'实时语音':'结束语音');delete button.dataset.connecting;button.setAttribute('aria-pressed','true');
        status.textContent='正在听 · 可以随时插话';
        watcher=setInterval(()=>{if(Date.now()-lastPacket>4000)stop(frames?'麦克风音频中断，请重新开启。':'没有收到麦克风音频，请检查输入设备。');},1000);
        window.dispatchEvent(new Event('xim:voice-ready'));
      }else if(msg.type==='speech.start'){
        window.dispatchEvent(new Event('xim:speech-start'));status.textContent='正在听你说…';
      }else if(msg.type==='speech.end'){
        status.textContent='正在识别这句话…';
      }else if(msg.type==='transcript'){
        const text=typeof msg.text==='string'?msg.text:'';
        status.textContent=text?'听到了，正在回应':'没听清，可以再说一次。';
        if(!text&&compact)window.ximChat?.note(msg.reason==='overlap'?'听到不止一个人，请你单独再说一次。':'这一句没听清，可以再说一次。');
        window.dispatchEvent(new CustomEvent('xim:transcript',{detail:text}));
      }else if(msg.type==='error')stop(msg.message);
    };
    socket.onerror=()=>{if(ticket===generation)stop('语音连接失败，请重试。');};
    socket.onclose=()=>{if(ticket===generation)stop('语音连接已断开。');};
    stream.getTracks()[0].onended=()=>{if(ticket===generation)stop('麦克风已关闭。');};
  }catch(e){if(ticket===generation)stop(e.name==='NotAllowedError'?'没有麦克风权限。可继续使用文字对话。':'无法开启语音，请检查麦克风和本机服务。');}
};
window.addEventListener('pagehide',()=>stop());
