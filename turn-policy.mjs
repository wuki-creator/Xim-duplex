// Lightweight Xim interruption policy. It is an interpretable baseline, not a trained model.
// Classification only affects conversation control; it does not execute tasks.
export {interruptionIntent} from './public/duplex-policy.js';

export const turnPrompts={
  backchannel:'对方可能只是在附和。先给简短回应；不要假装听到了未播内容，也不要把附和理解成新任务。',
  yield:'用户要求暂时停下。简短表示愿意听，让用户继续，不要续说旧回答。',
  correction:'用户可能在纠正上一轮。优先接受最新说法，仅依据已播前缀重新回答，不要续播旧草稿。',
  new_input:'用户打断后提供了新内容。以新内容为准，结合已播前缀自然回应。',
};
