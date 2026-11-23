// Interpretable interruption baseline shared by the browser and Node tests.
// It classifies final transcripts only; it does not identify speakers or emotions.
export function interruptionIntent(text, interruption){
  if(!interruption||!['playing','generating'].includes(interruption.phase))return null;
  const value=String(text||'').trim().replace(/[\s，。！？,.!?、~～]+$/gu,'');
  if(/^(?:嗯+|嗯哼|哦+|啊+|是的|对的|好的|好|对)$/u.test(value))return 'backchannel';
  if(/^(?:等一下|等一等|等等|先别说|先停|停一下|让我先说)(?:吧|啊|呀)?$/u.test(value))return 'yield';
  if(/(?:不是|不对|说错了|我说的是|我的意思是|更正|改成|换成)/u.test(value))return 'correction';
  return 'new_input';
}
