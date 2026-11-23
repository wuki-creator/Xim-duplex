// Privacy-preserving development trace: event names, phases and timing only.
// No transcript, audio, model output, user identifier or network address is stored.
export class InteractionLog{
  constructor({now=()=>performance.now(),wallNow=()=>new Date().toISOString(),limit=500}={}){
    this.now=now;this.wallNow=wallNow;this.limit=limit;this.events=[];this.startedAt=wallNow();
  }
  mark(type,{phase=null,intent=null}={}){
    if(typeof type!=='string'||!/^[\w.-]+$/.test(type))throw Error('Invalid event');
    const event={t_ms:Math.round(this.now()*100)/100,type};
    if(['idle','generating','playing'].includes(phase))event.phase=phase;
    if(['backchannel','yield','correction','new_input'].includes(intent))event.intent=intent;
    this.events.push(event);if(this.events.length>this.limit)this.events.shift();
    return event;
  }
  export({version,model=null}={}){
    return {schema:'xim-interaction-trace-v1',started_at:this.startedAt,exported_at:this.wallNow(),version:String(version||'unknown'),model:typeof model==='string'?model.slice(0,120):null,audio_included:false,transcript_included:false,events:[...this.events]};
  }
}
