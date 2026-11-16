// Public conversation events, not the model's hidden reasoning. Kept in memory only.
export class DialogueState {
  constructor(){this.clear();}
  clear(){this.nodes=[];this.next=0;this.branch=null;}
  begin(text){
    const node={id:++this.next,parent:this.nodes.at(-1)?.id??null,text,reply:'',heard:0,status:'generating',spoken:false,interruption:this.branch};
    this.branch=null;this.nodes.push(node);this.nodes=this.nodes.slice(-30);return node;
  }
  complete(node,reply,spoken){node.reply=reply;node.spoken=spoken;node.heard=spoken?0:reply.length;node.status=spoken?'playing':'complete';}
  acknowledge(node,offset){
    if(node.status!=='playing'||!Number.isFinite(offset))return;
    node.heard=Math.max(node.heard,Math.min(node.reply.length,Math.floor(offset)));
    if(node.heard===node.reply.length)node.status='complete';
  }
  interrupt(node,reason='user_speech'){
    if(!node||!['generating','playing'].includes(node.status))return null;
    const phase=node.status;node.status='interrupted';
    this.branch={parentTurn:node.id,phase,reason,heardPrefix:node.reply.slice(0,node.heard),unplayedCharacters:node.reply.length-node.heard};
    return this.branch;
  }
  request(node){
    const before=this.nodes.slice(0,this.nodes.indexOf(node));
    const history=before.flatMap(n=>[
      {role:'user',content:n.text},
      ...(n.heard?[{role:'assistant',content:n.reply.slice(0,n.heard)}]:[]),
    ]).slice(-10);
    return {text:node.text,history,interruption:node.interruption};
  }
}

// Small acknowledged chunks bound uncertainty when a browser has no word boundaries.
export function speechChunks(text,max=36){
  const chunks=[];let start=0,current='';
  for(const char of text){
    current+=char;
    if(current.length>=max||/[。！？!?；;\n]/.test(char)){
      chunks.push({text:current,start,end:start+current.length});start+=current.length;current='';
    }
  }
  if(current)chunks.push({text:current,start,end:start+current.length});
  return chunks;
}
