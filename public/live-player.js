const runKey=d=>JSON.stringify([d.run_id,d.turn_id]);

export class LivePlayer{
  constructor(context,send){
    this.context=context;this.send=send;this.runs=new Map();this.pending=null;this.tail=0;
    this.gain=context.createGain();this.gain.connect(context.destination);
    this.timer=setInterval(()=>this.confirm(),30);
  }
  mute(muted){this.gain.gain.setValueAtTime(muted?0:1,this.context.currentTime);}
  run(d){
    const key=runKey(d);
    if(!this.runs.has(key)){
      if(this.runs.size>=100){const old=[...this.runs].find(([,run])=>run.closed);if(old)this.runs.delete(old[0]);else throw Error('Too many audio replies');}
      this.runs.set(key,{id:{run_id:d.run_id,turn_id:d.turn_id},chunks:[],done:false,closed:false});
    }
    return this.runs.get(key);
  }
  speakFrame(bytes){
    const d=this.pending;this.pending=null;
    if(!d||!bytes.byteLength||bytes.byteLength%2)throw Error('Invalid audio frame');
    const run=this.run(d);if(run.closed)return;
    const context=this.context,start=Math.max(context.currentTime+.055,this.tail);
    const view=new DataView(bytes),buffer=context.createBuffer(1,bytes.byteLength/2,d.sampleRate),samples=buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
    if(start+buffer.duration-context.currentTime>20)throw Error('Audio backlog');
    const source=context.createBufferSource();source.buffer=buffer;source.connect(this.gain);
    run.chunks.push({source,start,end:start+buffer.duration,id:d.chunk_id});
    this.tail=start+buffer.duration;source.start(start);
  }
  position(){
    const ctx=this.context,clock=ctx.getOutputTimestamp?.();
    return clock?.performanceTime>0?Math.min(ctx.currentTime,clock.contextTime):Math.max(0,ctx.currentTime-(ctx.baseLatency||0)-(ctx.outputLatency||0));
  }
  confirm(position=this.position()){
    for(const run of this.runs.values()){
      if(run.closed)continue;
      while(run.chunks.length&&run.chunks[0].end<=position){
        const chunk=run.chunks.shift();chunk.source.disconnect();this.send({action:'playback.chunk.completed',...run.id,chunk_id:chunk.id});
      }
      if(run.done&&!run.chunks.length){run.closed=true;this.send({action:'playback.completed',...run.id});}
    }
  }
  event(action,d){
    if(!d.run_id||!d.turn_id)return;
    if(action==='response.audio.done'){this.run(d).done=true;return;}
    if(action==='response.audio.stop'||action==='response.interrupted'||(action==='response.ended'&&d.status!=='completed')){
      const run=this.run(d);if(run.closed)return;
      const position=this.position();run.done=false;this.confirm(position);
      const head=run.chunks[0];run.closed=true;
      for(const ch of run.chunks){try{ch.source.stop();}catch{}ch.source.disconnect();}
      run.chunks.length=0;
      this.tail=Math.max(this.context.currentTime,...[...this.runs.values()].map(r=>r.chunks.at(-1)?.end||0));
      this.send({action:'playback.stopped',...run.id,played_audio_ms:head?Math.floor(1000*Math.max(0,Math.min(position,head.end)-head.start)):0});
    }
  }
  close(){
    clearInterval(this.timer);this.pending=null;
    for(const run of this.runs.values())for(const ch of run.chunks){try{ch.source.stop();}catch{}ch.source.disconnect();}
    this.runs.clear();this.gain.disconnect();
  }
}
