// Xim's local inference boundaries; never send API credentials to a configured URL.
export function loopbackUrl(value,pathname){
  const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw Error('LOCAL_MODEL_CONFIGURATION');
  u.pathname=pathname;u.search='';u.hash='';return u.href;
}
export async function localChat({url,model,text,history,interruption,signal,request=fetch}){
  const prompt='你是伴点，一个温暖、尊重边界的中文桌面伙伴。自然回应，用户纠正时听取最新的意思。不声称执行了外部操作。只输出 JSON：{"segments":[{"text":"回复","emotion":"warm"}],"task":null}。emotion 使用 joy、warm、calm、curious、support、celebrate。';
  const interrupted=interruption&&['playing','generating'].includes(interruption.phase);
  const content=interrupted?JSON.stringify({user_message:text,interruption:{phase:interruption.phase,heard_prefix:typeof interruption.heardPrefix==='string'?interruption.heardPrefix.slice(0,1400):''}}):text;
  const response=await request(loopbackUrl(url,'/v1/chat/completions'),{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:prompt+(interrupted?' 用户打断了上一轮，历史中只有已经确认的语音前缀；回应用户最新的纠正。':'')},...history,{role:'user',content}],temperature:.65,max_tokens:320,stream:false})});
  if(!response.ok){await response.body?.cancel();throw Error('LOCAL_CHAT_UNAVAILABLE');}
  const result=await response.json(),value=result.choices?.[0]?.message?.content;
  if(typeof value!=='string'||!value.trim()||value.length>10000||result.choices?.[0]?.finish_reason!=='stop')throw Error('LOCAL_CHAT_UNAVAILABLE');
  const clean=value.trim(),fenced=clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;try{parsed=JSON.parse(fenced?.[1]??clean);}catch{
    if(/^(?:\{|\[|```)/.test(clean))throw Error('LOCAL_CHAT_UNAVAILABLE');
    parsed={segments:[{text:clean,emotion:'warm'}]};
  }
  const emotions=new Set(['joy','warm','calm','curious','support','celebrate']);
  const segments=(Array.isArray(parsed.segments)?parsed.segments:[]).slice(0,6).filter(x=>typeof x?.text==='string'&&x.text.trim()).map(x=>({text:x.text.trim().slice(0,1400),emotion:emotions.has(x.emotion)?x.emotion:'warm'}));
  if(!segments.length||segments.reduce((a,x)=>a+x.text.length,0)>1600)throw Error('LOCAL_CHAT_UNAVAILABLE');
  return {segments,task:null};
}

// A replaceable local worker contract; no provider demo voices, keys or endpoints.
export async function localSpeech({url,model,text,voice='default',signal,request=fetch}){
  const response=await request(loopbackUrl(url,'/v1/audio/speech'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,input:text,voice,response_format:'wav'}),signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw Error('LOCAL_SPEECH_UNAVAILABLE');}
  const max=4000000,declared=Number(response.headers.get('content-length'));
  if(declared>max){await response.body?.cancel();throw Error('LOCAL_SPEECH_UNAVAILABLE');}
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>max)throw Error('LOCAL_SPEECH_UNAVAILABLE');chunks.push(chunk);}
  const wav=Buffer.concat(chunks);
  if(wav.length<44||wav.length>4000000||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('LOCAL_SPEECH_UNAVAILABLE');
  return wav;
}
