// A learned acoustic endpoint is advisory. Failure falls back to the existing VAD.
// This model predicts turn completion, not user intent or permission to execute.
export async function predictTurn({url,pcm,signal,request=fetch,timeoutMs=800}){
  if(!url)return null;
  try{
    const target=new URL(url);
    if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password)return null;
    target.pathname='/predict';target.search='';target.hash='';
    const timeout=AbortSignal.timeout(timeoutMs);
    const response=await request(target.href,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pcm,redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if(!response.ok){await response.body?.cancel();return null;}
    // The local worker returns only a tiny decision, never a transcript.
    let size=0,parts=[];
    for await(const part of response.body){size+=part.length;if(size>4096){await response.body?.cancel().catch(()=>{});return null;}parts.push(part);}
    const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(typeof value.complete!=='boolean'||!Number.isFinite(value.probability)||value.probability<0||value.probability>1)return null;
    return {complete:value.complete,probability:value.probability};
  }catch{return null;}
}

// Releases accumulated ASR segments only while idle. An incomplete acoustic turn
// gets one bounded grace period; resumed speech invalidates that timer.
export class TurnReleaseGate{
  constructor({canRelease,onRelease,holdMs=1400,schedule=setTimeout,unschedule=clearTimeout}){
    Object.assign(this,{canRelease,onRelease,holdMs,schedule,unschedule});this.timer=null;this.generation=0;
  }
  cancel(){this.generation++;if(this.timer!==null)this.unschedule(this.timer);this.timer=null;}
  update(complete){
    this.cancel();if(!this.canRelease())return;
    if(complete!==false){this.onRelease();return;}
    const generation=this.generation;
    this.timer=this.schedule(()=>{this.timer=null;if(generation===this.generation&&this.canRelease())this.onRelease();},this.holdMs);
  }
}
