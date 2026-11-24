import {simpleWorkbenchAction} from './workbench.mjs';

const meetingVerb=/^\s*(?:(?:请|帮我|麻烦|我要|我想|我想要)\s*)*(?:创建|组织|发起|安排|开)(?:一场|一个|一次|个)?[^，。！？]{0,24}(?:会议|会)/u;
const meetingResize=/^\s*(?:(?:请|帮我)\s*)*(?:加到|增加到|调整为|改成)\s*(?:\d{1,2}|[一二两三四五六七八九十])\s*(?:位|名|个)?\s*(?:参会者|与会者|参与者|成员|席位)/u;
const sceneDomain=/机械臂|物理工作台|物理场景|虚拟场景|当前场景|场景|方块|球体|圆柱|小砖/u;
const sceneAction=/添加|创建|放一个|加一个|移动|移到|放到|涂成|换成|抓起|抓取|拿起|释放|松开|下落|轨迹|计算|下载/u;
const refusal=/^\s*(?:请\s*)?(?:不要|别|先不要|先别|不用|无需|取消)/u;
const question=/[?？]|(?:吗|可不可以|能不能|能否)\s*[。！!]*\s*$/u;

// Route only explicit task utterances. Model-provided tool fields are never
// accepted here; execution remains inside the bounded meeting/workbench APIs.
export function routeVoiceTask(value){
  const input=typeof value==='string'?value.trim():'';
  if(!input||input.length>1000||refusal.test(input)||question.test(input))return null;
  if(meetingVerb.test(input)||meetingResize.test(input))return {kind:'meeting',input};
  if(simpleWorkbenchAction(input)||(sceneDomain.test(input)&&sceneAction.test(input)))return {kind:'workbench',input};
  return null;
}
