// The provider's input transcript IDs are not the assistant's audio run IDs.
// Join consecutive confirmed fragments until an answer starts playing.
const runKey=d=>JSON.stringify([d.run_id,d.turn_id]);
const meaningful=text=>{
  const words=text.replace(/[\s\p{P}\p{S}]/gu,'');
  if(/^(?:先别(?:说|回答)|别说话|不用回答|不需要回答|让我想想|等我(?:说完|想想)|我还没说完)/u.test(words))return false;
  if(/^(?:[嗯呃哦啊唔诶]+|好的?|是的?|对的?|行|可以|知道了|我知道了|(?:等一下|等等|稍等)(?:啊|吧|我想想|我还没说完)?)$/u.test(words))return false;
  return /[?？]/.test(text)||/^(?:你好|嗨|哈喽|在吗|你在吗)$/u.test(words)||Array.from(words).length>=4;
};

export class LiveTurns {
  constructor(){this.clear();}
  clear(){this.current=null;this.speaking=false;this.seq=0;this.byTurn=new Map();this.runs=new Map();this.stoppedAt=null;}
  make(){const group={id:++this.seq,parts:new Map(),text:'',at:null,answered:false};this.current=group;return group;}
  start(){this.speaking=true;this.stoppedAt=null;if(!this.current||this.current.answered)this.make();}
  stop(now){this.speaking=false;this.stoppedAt=now;}
  confirm(data,now,revision=false){
    const text=data.text?.trim();if(!text)return null;
    const known=data.turn&&this.byTurn.get(data.turn);
    if(revision&&!known)return null;
    const group=known||this.current||this.make();
    if(!known&&data.turn){
      this.byTurn.set(data.turn,group);
      if(this.byTurn.size>100)this.byTurn.delete(this.byTurn.keys().next().value);
    }
    const key=data.turn||Symbol();
    if(group.parts.get(key)===text)return null;
    group.parts.set(key,text);
    if(group.parts.size>30)group.parts.delete(group.parts.keys().next().value);
    group.text=[...group.parts.values()].join(' ').slice(-2000);group.at=now;
    return {id:group.id,text:group.text};
  }
  associate(data){
    if(!data.run_id||!data.turn_id)return;
    const key=runKey(data);
    if(!this.runs.has(key)){
      this.runs.set(key,this.current);
      if(this.runs.size>100)this.runs.delete(this.runs.keys().next().value);
    }
  }
  audio(data){this.associate(data);const group=this.runs.get(runKey(data));if(group)group.answered=true;}
  waiting(now){
    const group=this.current;
    if(!group?.text||group.answered||this.speaking)return null;
    const elapsed=now-Math.max(group.at,this.stoppedAt??group.at);
    return {id:group.id,text:group.text,elapsed,recoverable:meaningful(group.text)};
  }
  take(now,{automatic=false}={}){
    const turn=this.waiting(now);
    if(!turn||turn.elapsed<(automatic?6500:2800)||(automatic&&!turn.recoverable))return null;
    this.current.answered=true;
    return turn;
  }
}
