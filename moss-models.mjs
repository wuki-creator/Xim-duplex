const api='https://api.mosi.cn/v1';
export const nexModel='nex-n2.6';
export const ttsModel='moss-tts-1.5-flash';
export const asrModels=new Set(['moss-transcribe-1.0','moss-transcribe-diarize-pro']);

export function pcmWav(pcm){
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);
  header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

export async function transcribeMoss({key,model,pcm,signal,request=fetch}){
  if(!asrModels.has(model))throw Error('Unsupported ASR model');
  const body=new FormData();body.set('model',model);
  body.set('response_format',model==='moss-transcribe-diarize-pro'?'diarized_json':'json');
  body.set('file',new Blob([pcmWav(pcm)],{type:'audio/wav'}),'utterance.wav');
  const response=await request(api+'/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body,signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw Error('Transcription unavailable');}
  const result=await response.json();
  // Anonymous diarization labels are not identity or proof of who addressed the device.
  const distinctSpeakers=new Set((Array.isArray(result.segments)?result.segments:[]).map(s=>s?.speaker).filter(s=>typeof s==='string'&&s));
  if(distinctSpeakers.size>1)return {text:'',reason:'overlap'};
  const value=typeof result.text==='string'?result.text.trim():'';
  return {text:value,reason:value?null:'no_match'};
}

export async function synthesizeMoss({key,voice,text,signal,request=fetch}){
  const response=await request(api+'/audio/speech',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:ttsModel,input:text,voice_id:voice,response_format:'wav',delivery_method:'audio'}),signal,redirect:'error'});
  if(!response.ok||!response.body||!/^audio\//i.test(response.headers.get('content-type')||'')){
    await response.body?.cancel();throw Error('Speech synthesis unavailable');
  }
  const parts=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>4000000)throw Error('Audio too long');parts.push(chunk);}
  const wav=Buffer.concat(parts,size);
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('Invalid WAV');
  return wav;
}
