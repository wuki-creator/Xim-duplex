// Independent audio ingress remains active while the browser plays assistant speech.
// This energy VAD is a baseline, not semantic turn-taking or background-speaker separation.
export class VadSegmenter {
  constructor({onStart,onEnd,threshold=.012,startMs=160,silenceMs=700,maxMs=14000}){
    Object.assign(this,{onStart,onEnd,threshold,startMs,silenceMs,maxMs});this.reset();
  }
  reset(){this.frames=[];this.pre=[];this.voiced=0;this.silence=0;this.duration=0;this.active=false;}
  finish(){
    if(!this.active)return false;
    const pcm=Buffer.concat(this.frames);this.reset();this.onEnd(pcm);return true;
  }
  push(frame){
    let power=0;for(let i=0;i<frame.length;i+=2){const n=frame.readInt16LE(i)/32768;power+=n*n;}
    const rms=Math.sqrt(power/(frame.length/2||1)),ms=frame.length/32;
    if(!this.active){
      this.pre.push(Buffer.from(frame));while(this.pre.reduce((n,b)=>n+b.length,0)>25600)this.pre.shift();
      this.voiced=rms>=this.threshold?this.voiced+ms:0;
      if(this.voiced>=this.startMs){this.active=true;this.frames=this.pre;this.pre=[];this.duration=this.voiced;this.onStart();}
      return;
    }
    this.frames.push(Buffer.from(frame));this.duration+=ms;this.silence=rms<this.threshold*.8?this.silence+ms:0;
    if(this.silence>=this.silenceMs||this.duration>=this.maxMs){
      this.finish();
    }
  }
}
