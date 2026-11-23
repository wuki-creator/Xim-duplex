import {interruptionIntent} from './duplex-policy.js';

// Two-stage duplex control: hold the current output while speech is recognized,
// then either resume it for a backchannel or cancel it for a genuine new input.
// This is an application-level policy, not an end-to-end speech model.
export class DuplexController{
  constructor(){this.phase='idle';this.pending=false;}
  output(phase){
    if(!['idle','generating','playing'].includes(phase))throw Error('Invalid output phase');
    this.phase=phase;
    if(phase==='idle')this.pending=false;
  }
  beginSpeech(){
    if(this.phase==='idle')return {action:'listen'};
    this.pending=true;
    return {action:'hold',phase:this.phase};
  }
  resolveSpeech(text){
    const phase=this.phase,held=this.pending;
    this.pending=false;
    const value=String(text||'').trim();
    if(phase==='idle'||!held)return value?{action:'respond'}:{action:'ignore'};
    if(!value)return {action:'resume',reason:'unrecognized',phase};
    const intent=interruptionIntent(value,{phase});
    if(intent==='backchannel')return {action:'resume',intent,phase};
    return {action:'interrupt',intent:intent||'new_input',phase};
  }
}
