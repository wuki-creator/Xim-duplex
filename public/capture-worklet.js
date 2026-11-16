class XimCapture extends AudioWorkletProcessor {
  constructor(){super();this.sum=0;this.count=0;this.phase=0;this.buffer=new Int16Array(800);this.at=0;}
  process(inputs){
    const samples=inputs[0]?.[0];if(!samples)return true;
    for(const v of samples){
      this.sum+=v;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){
        this.phase-=sampleRate;
        this.buffer[this.at++]=Math.max(-32768,Math.min(32767,Math.round(this.sum/this.count*32767)));
        this.sum=0;this.count=0;
        if(this.at===800){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(800);this.at=0;}
      }
    }
    return true;
  }
}
registerProcessor('xim-capture',XimCapture);
