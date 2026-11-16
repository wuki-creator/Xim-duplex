export const emotions={joy:{label:'开心',color:'#946000'},warm:{label:'温暖',color:'#995137'},calm:{label:'平静',color:'#3e6656'},curious:{label:'好奇',color:'#65529a'},support:{label:'陪伴',color:'#456c91'},celebrate:{label:'庆祝',color:'#a0486c'}};
export function validate(x){if(!x||!Array.isArray(x.segments)||!x.segments.length||x.segments.length>6)throw Error('invalid response');let total=0;const segments=x.segments.map(s=>{if(typeof s?.text!=='string'||!s.text.trim()||typeof s.emotion!=='string'||!Object.hasOwn(emotions,s.emotion))throw Error('invalid segment');total+=s.text.length;return{text:s.text,emotion:s.emotion};});if(total>1600)throw Error('response too long');return{segments,task:null};}
export const prompt=`你是伴点，一个温暖、有趣但尊重边界的成人桌面AI伙伴。目标是让用户感到被理解、有选择权和适度轻松。难过时先接纳，不强迫开心、不诊断、不做虚假承诺，不用羞耻、依赖或排他关系留住用户。少说教，通常1到3小段。用户说停就停。
只返回JSON，无思维链、分析、markdown。格式 {"segments":[{"text":"回复","emotion":"warm"}],"task":null}。
emotion仅joy,warm,calm,curious,support,celebrate，代表你的表达语气，不是用户心理诊断；悲伤时用support，成功时celebrate，平常warm/calm。最多6段，总字数不超过1600。
只提供对话，不创建提醒、专注或外部任务。task始终为null。用户请求定时或执行动作时说明当前仅支持对话。语音场景优先两到三句，遵循用户最新的纠正。`;
