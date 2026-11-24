import {World,palette} from './world.js';
const $=id=>document.getElementById(id),coords=['px','py','pz'].map($),history=[];
const labels={box:'方块',sphere:'球体',cylinder:'圆柱'};
const errors={PATH_BLOCKED:'机械臂末端的直线路径经过其他物体，请移动障碍物或换一个目标。',UNREACHABLE:'目标超出虚拟机械臂的活动范围，或直线经过底座附近。请把目标移近一些。',MODEL_UNAVAILABLE:'暂时连不上本地对话模型，请再试一次。',MODEL_NOT_CONFIGURED:'请先启动本地对话模型。',COMPUTE_UNAVAILABLE:'暂时无法完成计算。',IMAGE_NOT_CONFIGURED:'图片服务尚未配置。',IMAGE_BALANCE:'图片服务资源不足。',IMAGE_FORBIDDEN:'当前账号没有生图权限，或请求未通过平台审核。',IMAGE_UNAVAILABLE:'暂时无法生成图片，请稍后重试。',BUSY:'上一项操作还在继续，请稍等。'};
let world,boot,report,imagePrompt,planning,armPending=false,generating=false,voice=false;
const handledTasks=new Set();

try{world=new World($('viewport'),refresh);}catch(error){$('worldError').hidden=false;console.error(error.name);}
refresh();
fetch('/api/bootstrap').then(r=>{if(!r.ok)throw Error();return r.json();}).then(x=>{
  boot=x;
  const params=new URLSearchParams(location.search),command=params.get('command'),task=params.get('task')||'';
  if(command){window.history.replaceState(null,'','/workbench.html');acceptTask(task,command);}
}).catch(()=>log('暂时连不上本机服务。','error'));

function log(text,role='assistant',withVoice=false){
  const p=document.createElement('p');p.dataset.role=role;p.textContent=text;$('activity').append(p);
  while($('activity').children.length>18)$('activity').firstElementChild.remove();
  $('activity').scrollTop=$('activity').scrollHeight;
  if(role==='user'||role==='assistant'){history.push({role,content:text});if(history.length>8)history.shift();}
  if(withVoice&&voice&&window.speechSynthesis){
    const say=new SpeechSynthesisUtterance(text);say.lang='zh-CN';say.rate=.95;window.speechSynthesis.speak(say);
  }
}
function failure(e){if(e.name!=='AbortError')log(errors[e.message]||e.message||'暂时无法完成。','error',true);}
function refresh(){
  const selected=world?.objects.get(world.selected),items=world?[...world.objects.values()]:[];
  if(!world){document.querySelectorAll('[data-add], #physicsToggle, #pathCompute, #physicsCompute, #grasp, #place, #release, #removeObject, #positionForm button').forEach(b=>b.disabled=true);return;}
  const output=$('objectList'),focusId=output.contains(document.activeElement)?document.activeElement.dataset.id:null;
  output.replaceChildren();
  for(const item of items){
    const b=document.createElement('button');b.type='button';b.className='object-item';b.dataset.id=item.id;b.setAttribute('aria-pressed',String(item===selected));
    const swatch=document.createElement('span');swatch.className='swatch';swatch.style.setProperty('--swatch','#'+palette[item.color].toString(16));swatch.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.textContent=item.name;
    const kind=document.createElement('span');kind.className='kind';kind.textContent=item.id===world.held?'抓取中':labels[item.shape];
    b.append(swatch,name,kind);b.onclick=()=>world.select(item.id);output.append(b);if(focusId===item.id)b.focus();
  }
  $('objectCount').textContent=items.length+' 件';
  for(const [i,input] of coords.entries())if(input!==document.activeElement)input.value=selected?selected.mesh.position.toArray()[i].toFixed(2):'';
  $('physicsToggle').textContent=world.playing?'Ⅱ 暂停模拟':'▶ 开始模拟';$('physicsToggle').setAttribute('aria-pressed',String(world.playing));
  const active=Boolean(world.animation||armPending);
  $('grasp').disabled=active||!selected||Boolean(world.held);$('pathCompute').disabled=active||!selected;
  $('place').disabled=active||!world.held;$('release').disabled=active||!world.held;
  $('removeObject').disabled=active||!selected||selected.id===world.held;
}
function requireWorld(){if(!world)throw Error('3D 场景暂不可用。');return world;}
const position=()=>coords.map(input=>input.valueAsNumber);
async function post(path,body,signal){
  if(!boot)throw Error('本机服务还在连接，请稍等。');
  const response=await fetch('/api/workbench/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bandi-Token':boot.token},body:JSON.stringify(body),signal});
  const data=await response.json();if(!response.ok)throw Error(data.error||'暂时无法完成。');return data;
}
function reportResult(result,title){
  report=result;$('resultLabel').textContent=title+(result.location==='server'?' · 服务器计算':' · 本机计算');
  const caption=result.job==='arm'?['轨迹时长','采样点','起点 (X, Y, Z)','终点 (X, Y, Z)']:['物体','离地高度','预计下落时间','落地前速度'];
  const vector=v=>v.map(n=>n.toFixed(2)).join('，');
  const rows=result.job==='arm'?[[result.duration+' 秒',result.samples.length,vector(result.samples[0].position),vector(result.samples.at(-1).position)]]:
    result.objects.map(o=>[world?.objects.get(o.id)?.name||o.id,o.dropHeight+' m',o.fallTime+' s',o.impactSpeed+' m/s']);
  const table=document.createElement('table'),head=table.createTHead().insertRow();
  for(const title of caption){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;head.append(cell);}
  const body=table.createTBody();for(const row of rows){const tr=body.insertRow();for(const value of row)tr.insertCell().textContent=value;}
  $('resultData').replaceChildren(table);
}
async function motion(action,{target,position:desired}){
  const stage=requireWorld();if(armPending||stage.animation)throw Error('机械臂正在移动，请稍等。');
  const item=stage.objects.get(target||stage.selected);
  if(action==='pick'&&stage.held)throw Error('机械臂已经拿着物体。');
  if(action==='place'&&!stage.held)throw Error('请先让机械臂抓住一个物体。');
  if(!desired&&!item)throw Error('先选择一个物体，再计算轨迹。');
  const offset=action==='place'?stage.holdOffset:(item?.size||1)/2+.13;
  const goal=desired?[desired[0],desired[1]+(action==='place'?offset:0),desired[2]]:item.mesh.position.toArray().map((v,i)=>i===1?v+offset:v);
  const revision=stage.rev;armPending=true;refresh();
  try{
    const obstacles=stage.export().objects.filter(o=>o.id!==(target||(!desired?item?.id:null))&&o.id!==stage.held).map(o=>({position:o.position,size:o.size}));
    const result=await post('compute',{job:'arm',start:stage.arm,target:goal,obstacles});
    if(stage.rev!==revision)throw Error('场景在计算中发生变化，请重新计算。');
    reportResult(result,'机械臂轨迹 · '+result.samples.length+' 个点');
    if(action==='trajectory'){stage.trace.geometry.setFromPoints(result.samples.map(({position:p})=>stage.grip.clone().set(...p)));log('轨迹已画在场景里。','assistant',true);return;}
    stage.animate(result.samples,()=>{
      if(action==='pick'){stage.pick(item.id);log('已抓住'+item.name+'。','assistant',true);}
      else {stage.release();log('已放到指定位置。','assistant',true);}
      refresh();
    });
    log(action==='pick'?'机械臂正在移动到'+item.name+'。':'机械臂正在移到目标坐标。','assistant',true);
  }finally{armPending=false;refresh();}
}
function downloadText(name,contents,type){
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([contents],{type}));
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function blender(scene){
  const payload=btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(scene))));
  return [
    '# Xim workshop scene. Run in Blender: Scripting → Open → Run Script.',
    'import base64, json, bpy','from mathutils import Quaternion',
    'data = json.loads(base64.b64decode("'+payload+'").decode("utf-8"))',
    'collection = bpy.data.collections.new("Xim Workshop")','bpy.context.scene.collection.children.link(collection)',
    'def belongs(o):','    for c in list(o.users_collection): c.objects.unlink(o)','    collection.objects.link(o)',
    'bpy.ops.mesh.primitive_plane_add(size=20)','floor = bpy.context.object','floor.name = "Xim Ground"','belongs(floor)',
    'palette = {"jade":(0.17,0.47,0.32,1), "amber":(0.78,0.42,0.12,1), "coral":(0.64,0.20,0.17,1), "ivory":(0.8,0.74,0.58,1), "blue":(0.19,0.32,0.56,1)}',
    'basis = Quaternion((1, 0, 0), 1.5707963267948966)',
    'for item in data["objects"]:',
    '    x, y, z = item["position"]','    size = item["size"]','    location = (x, -z, y)',
    '    if item["shape"] == "sphere": bpy.ops.mesh.primitive_uv_sphere_add(radius=size/2, location=location)',
    '    elif item["shape"] == "cylinder": bpy.ops.mesh.primitive_cylinder_add(radius=size/2, depth=size, location=location)',
    '    else: bpy.ops.mesh.primitive_cube_add(size=size, location=location)',
    '    o = bpy.context.object','    o.name = item["name"]','    belongs(o)',
    '    qx, qy, qz, qw = item["rotation"]','    o.rotation_mode = "QUATERNION"',
    '    o.rotation_quaternion = basis @ Quaternion((qw, qx, qy, qz)) @ basis.inverted()',
    '    mat = bpy.data.materials.new("Xim " + item["color"])','    mat.diffuse_color = palette.get(item["color"], palette["jade"])','    o.data.materials.append(mat)',
  ].join('\n')+'\n';
}
function download(kind){
  if(kind==='report'){if(!report)throw Error('请先运行一次计算。');downloadText('xim-compute.json',JSON.stringify(report,null,2),'application/json');}
  else if(kind==='gltf')downloadText('xim-workshop.gltf',JSON.stringify(requireWorld().gltf()),'model/gltf+json');
  else {const scene=requireWorld().export();if(kind==='blender')downloadText('xim-world-for-blender.py',blender(scene),'text/plain');else downloadText('xim-scene.json',JSON.stringify(scene,null,2),'application/json');}
  log('已发起下载。','assistant',true);
}
async function execute(a){
  if(a.action==='talk'){log(a.reply,'assistant',true);return;}
  if(a.action==='download'){download(a.file);return;}
  if(a.action==='image'){
    if(generating||$('imageDialog').open)throw Error('请先完成上一张图片。');
    imagePrompt=a.prompt;$('imagePrompt').textContent=a.prompt;$('imageDialog').showModal();return;
  }
  const stage=requireWorld();
  if(a.action==='add'){const item=stage.add(a);log('已添加'+item.name+'。','assistant',true);}
  if(a.action==='move'){stage.move(a.target,a.position);log('已移动到指定坐标。','assistant',true);}
  if(a.action==='paint'){stage.paint(a.target,a.color);log('已更新颜色。','assistant',true);}
  if(a.action==='release'){if(stage.animation)throw Error('请等机械臂停止移动。');if(!stage.release())throw Error('机械臂当前没有抓住物体。');log('机械臂已松开。','assistant',true);}
  if(a.action==='physics'){
    const result=await post('compute',{job:'physics',objects:stage.export().objects});reportResult(result,'场景下落估算');log('场景下落结果已经算好。','assistant',true);
  }
  if(['trajectory','pick','place'].includes(a.action))await motion(a.action,a);
}
async function submit(line){
  const input=line.trim().slice(0,1000);if(!input)return;
  planning?.abort();const abort=new AbortController();planning=abort;
  const context={objects:world?.export().objects||[],selected:world?.selected||null,history:history.slice()};
  log(input,'user');$('commandSend').textContent='理解中…';
  try{const intent=await post('intent',{input,context},abort.signal);if(!abort.signal.aborted)await execute(intent);}
  catch(e){failure(e);}finally{if(planning===abort){planning=null;$('commandSend').textContent='发送 ↑';}}
}
function acceptTask(id,line){
  const key=typeof id==='string'?id.slice(0,80):'';
  if(key&&handledTasks.has(key))return;
  if(typeof line!=='string'||!line.trim())return;
  if(key){handledTasks.add(key);if(handledTasks.size>32)handledTasks.delete(handledTasks.values().next().value);}
  void submit(line);
}
const taskChannel='BroadcastChannel' in window?new BroadcastChannel('xim-tasks'):null;
if(taskChannel)taskChannel.onmessage=event=>{
  const data=event.data;
  if(data?.type==='workbench-command')acceptTask(data.id,data.input);
};
$('command').onsubmit=e=>{e.preventDefault();const input=$('commandText');const text=input.value;input.value='';void submit(text);};
window.addEventListener('xim:transcript',e=>{if(e.detail)void submit(e.detail);});
window.addEventListener('xim:voice-ready',()=>{voice=true;});
window.addEventListener('xim:voice-closed',()=>{voice=false;});
window.addEventListener('xim:speech-start',()=>window.speechSynthesis?.cancel());
const apply=(action,args={})=>execute({action,...args}).catch(failure);
for(const b of document.querySelectorAll('[data-add]'))b.onclick=()=>apply('add',{shape:b.dataset.add});
for(const b of document.querySelectorAll('[data-download]'))b.onclick=()=>apply('download',{file:b.dataset.download});
$('physicsToggle').onclick=()=>world?.togglePhysics();
$('physicsCompute').onclick=()=>apply('physics');
$('pathCompute').onclick=()=>apply('trajectory',{target:world?.selected});
$('grasp').onclick=()=>apply('pick',{target:world?.selected});
$('place').onclick=()=>apply('place',{position:position()});
$('release').onclick=()=>apply('release');
$('removeObject').onclick=()=>world?.remove(world.selected);
$('positionForm').onsubmit=e=>{e.preventDefault();void apply('move',{target:world?.selected,position:position()});};
$('imageCancel').onclick=()=>$('imageDialog').close();
$('imageConfirm').onclick=async()=>{
  const prompt=imagePrompt;if(!prompt||generating)return;
  generating=true;$('imageDialog').close();$('resultLabel').textContent='正在生成图片…';
  try{
    const {url}=await post('image',{prompt,confirmed:true});
    const img=new Image();img.src=url;img.alt=prompt;img.referrerPolicy='no-referrer';
    const link=document.createElement('a');link.href=url;link.download=url.startsWith('data:image/jpeg;')?'xim-image.jpg':'xim-image.png';link.textContent='下载图片';
    $('imageResult').replaceChildren(img,link);$('resultLabel').textContent='图片已生成';log('图片已经生成，在作品区可以看。','assistant',true);
  }catch(e){$('resultLabel').textContent='图片暂未生成';failure(e);}finally{generating=false;}
};
