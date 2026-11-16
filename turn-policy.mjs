// Lightweight Xim interruption policy. It is an interpretable baseline, not a trained model.
// Classification only affects how the next response is prompted; it does not execute tasks.
export function interruptionIntent(text, interruption){
  if(!interruption||!['playing','generating'].includes(interruption.phase))return null;
  const value=String(text||'').trim().replace(/[\s，。！？,.!?、~～]+$/gu,'');
  if(/^(?:嗯+|嗯哼|哦+|啊+|是的|对的|好的|好|对)$/u.test(value))return 'backchannel';
  if(/^(?:等一下|等一等|等等|先别说|先停|停一下|让我先说)(?:吧|啊|呀)?$/u.test(value))return 'yield';
  if(/(?:不是|不对|说错了|我说的是|我的意思是|更正|改成|换成)/u.test(value))return 'correction';
  return 'new_input';
}

export const turnPrompts={
  backchannel:'对方可能只是在附和。先给简短回应；不要假装听到了未播内容，也不要把附和理解成新任务。',
  yield:'用户要求暂时停下。简短表示愿意听，让用户继续，不要续说旧回答。',
  correction:'用户可能在纠正上一轮。优先接受最新说法，仅依据已播前缀重新回答，不要续播旧草稿。',
  new_input:'用户打断后提供了新内容。以新内容为准，结合已播前缀自然回应。',
};
