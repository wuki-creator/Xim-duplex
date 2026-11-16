// One audio chunk may be prepared while the current chunk plays. No whole-reply
// synthesis queue: interruptions discard this generation and all of its work.
export async function runSpeechQueue({chunks,load,play,fallback,acknowledge,signal,isCurrent=()=>true}){
  const alive=()=>!signal.aborted&&isCurrent();
  const cancelled={cancelled:true};
  let cancelWait;
  const abort=new Promise(resolve=>{cancelWait=()=>resolve(cancelled);signal.addEventListener('abort',cancelWait,{once:true});});
  // Attach rejection handlers immediately, including to speculative loads that
  // might finish after playback was cancelled or another request failed.
  const settle=fn=>Promise.resolve().then(fn).then(value=>({value}),error=>({error}));
  const wait=operation=>Promise.race([operation,abort]);
  let local=typeof load==='function',prepared=null;
  const prepare=index=>({index,promise:settle(()=>alive()?load(chunks[index],signal):cancelled)});
  try{
    if(!alive())return {status:'cancelled'};
    for(let index=0;index<chunks.length;index++){
      if(!alive())return {status:'cancelled'};
      const chunk=chunks[index];
      if(!chunk.text.trim()){acknowledge(chunk);continue;}
      let audio;
      if(local){
        if(prepared?.index!==index)prepared=prepare(index);
        const loaded=await wait(prepared.promise);prepared=null;
        if(!alive()||loaded.cancelled)return {status:'cancelled'};
        if(Object.hasOwn(loaded,'error'))local=false;
        else audio=loaded.value;
      }
      const playing=settle(()=>{
        if(!alive())return cancelled;
        return local?play(audio,chunk,signal):fallback(chunk,signal);
      });
      if(local){
        // Whitespace has no audio. Skip it when selecting the single next load,
        // but keep it in the acknowledgement sequence after playback completes.
        let next=index+1;
        while(next<chunks.length&&!chunks[next].text.trim())next++;
        if(next<chunks.length)prepared=prepare(next);
      }
      const ended=await wait(playing);
      if(!alive()||ended.cancelled)return {status:'cancelled'};
      if(Object.hasOwn(ended,'error'))throw ended.error;
      acknowledge(chunk);
    }
    return {status:'complete'};
  }finally{
    prepared=null;
    signal.removeEventListener('abort',cancelWait);
  }
}
