import * as T from './vendor/three.module.js';
import * as C from './vendor/cannon-es.js';

export const palette={amber:0xe8ab52,jade:0x73b79b,coral:0xd98070,ivory:0xe6ddc0,blue:0x7b9fd0};
const neutral=new T.Vector3(0,1,0),origin=new T.Vector3(0,.8,0);
const defaults=[{name:'琥珀方块',shape:'box',color:'amber',position:[2.45,.5,.65]},{name:'青绿球',shape:'sphere',color:'jade',position:[1.8,.42,-1.35],size:.84},{name:'蓝色圆柱',shape:'cylinder',color:'blue',position:[-.9,.55,1.45],size:1.1}];

function limb(radius,color){return new T.Mesh(new T.CylinderGeometry(radius,radius,1,24),new T.MeshStandardMaterial({color,metalness:.36,roughness:.48}));}
function segment(mesh,a,b){const delta=new T.Vector3().subVectors(b,a);mesh.position.copy(a).addScaledVector(delta,.5);mesh.scale.y=delta.length();mesh.quaternion.setFromUnitVectors(neutral,delta.normalize());}

export class World {
  constructor(el,onChange){
    this.el=el;this.onChange=onChange;this.objects=new Map();this.rev=0;this.held=null;this.playing=false;this.animation=null;this.selected=null;this.serial=0;this.arm=[2.6,1.45,.3];this.grip=new T.Vector3(...this.arm);
    this.scene=new T.Scene();this.scene.background=new T.Color(0x142926);this.scene.fog=new T.Fog(0x142926,19,46);
    this.camera=new T.PerspectiveCamera(39,1,.1,75);this.theta=.76;this.phi=.57;this.distance=14.3;this.focus=new T.Vector3(.55,.55,0);
    this.renderer=new T.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFSoftShadowMap;this.renderer.toneMapping=T.ACESFilmicToneMapping;
    el.prepend(this.renderer.domElement);this.renderer.domElement.setAttribute('aria-label','三维物理场景');
    this.rays=new T.Raycaster();this.pointer=new T.Vector2();
    this.scene.add(new T.HemisphereLight(0xe8f7f2,0x3a2b18,2.35));
    const key=new T.DirectionalLight(0xffdfac,2.4);key.position.set(3,8,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-7;key.shadow.camera.right=7;key.shadow.camera.top=7;key.shadow.camera.bottom=-7;key.shadow.normalBias=.014;this.scene.add(key);
    const plane=new T.Mesh(new T.PlaneGeometry(20,20),new T.MeshStandardMaterial({color:0x234541,roughness:.86}));plane.rotation.x=-Math.PI/2;plane.receiveShadow=true;this.scene.add(plane);this.ground=plane;
    const grid=new T.GridHelper(20,40,0x87b49e,0x426960);grid.position.y=.008;grid.material.transparent=true;grid.material.opacity=.52;this.scene.add(grid);
    this.sim=new C.World({gravity:new C.Vec3(0,-9.81,0)});this.sim.allowSleep=true;
    this.sim.defaultContactMaterial.friction=.46;this.sim.defaultContactMaterial.restitution=.22;
    const ground=new C.Body({mass:0,shape:new C.Plane()});ground.quaternion.setFromEuler(-Math.PI/2,0,0);this.sim.addBody(ground);
    const base=new T.Mesh(new T.CylinderGeometry(.52,.65,.6,48),new T.MeshStandardMaterial({color:0x485857,metalness:.55,roughness:.45}));base.position.y=.3;base.castShadow=true;this.scene.add(base);
    this.upper=limb(.17,0xdaad80);this.lower=limb(.136,0xa1ac9f);
    this.joint=new T.Mesh(new T.SphereGeometry(.224,28,20),new T.MeshStandardMaterial({color:0x343f40,metalness:.45,roughness:.5}));
    this.claw=new T.Group();const clawBase=limb(.145,0xe3b581);clawBase.scale.y=.17;this.claw.add(clawBase);
    const material=new T.MeshStandardMaterial({color:0xc9d4c8,metalness:.5,roughness:.46});
    for(const x of [-.14,.14]){const claw=new T.Mesh(new T.BoxGeometry(.075,.28,.15),material);claw.position.set(x,-.12,0);this.claw.add(claw);}
    this.scene.add(this.upper,this.lower,this.joint,this.claw);for(const m of [this.upper,this.lower,this.joint])m.castShadow=true;this.armMeshes=[[base,'臂座'],[this.upper,'上臂'],[this.joint,'肘关节'],[this.lower,'前臂']];
    this.aim(this.arm);
    this.selection=new T.BoxHelper(new T.Mesh(),0xf9db9c);this.selection.visible=false;this.scene.add(this.selection);
    this.trace=new T.Line(new T.BufferGeometry(),new T.LineBasicMaterial({color:0xffce83,transparent:true,opacity:.9}));this.scene.add(this.trace);
    this.bind();this.restore();this.refresh();
    const clock=new T.Clock();this.renderer.setAnimationLoop(()=>this.draw(Math.min(clock.getDelta(),.04)));
  }
  restore(){
    let scene;
    try{scene=JSON.parse(localStorage.getItem('xim.scene.v1'));}catch{}
    const visible=Array.isArray(scene?.objects)&&scene.objects.length?scene.objects:defaults;
    for(const obj of visible.slice(0,32)){try{this.add(obj,false);}catch{}}
    this.selected=this.objects.keys().next().value;
  }
  changed(){this.rev++;try{localStorage.setItem('xim.scene.v1',JSON.stringify(this.export()));}catch{}this.onChange?.();}
  export(){return {format:'xim-scene-v1',objects:[...this.objects.values()].map(({id,name,color,shape,size,mesh})=>({id,name,color,shape,size,position:mesh.position.toArray(),rotation:mesh.quaternion.toArray()}))};}
  gltf(){
    const file={asset:{version:'2.0',generator:'Xim Workshop'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],accessors:[],bufferViews:[],materials:[]};
    const raw=[];let length=0;
    function attribute(array,type,count,componentType,target,limits){
      const offset=(length+3)&~3,lengthBytes=array.byteLength;
      raw.push({offset,array});length=offset+lengthBytes;
      const view=file.bufferViews.push({buffer:0,byteOffset:offset,byteLength:lengthBytes,target})-1;
      return file.accessors.push({bufferView:view,componentType,count,type,...limits})-1;
    }
    const objects=[...[...this.objects.values()].map(o=>[o.mesh,o.name]),[this.ground,'实验台面'],...this.armMeshes];
    for(const [mesh,name] of objects){
      const geo=mesh.geometry;geo.computeBoundingBox();const limits={min:geo.boundingBox.min.toArray(),max:geo.boundingBox.max.toArray()};
      const p=geo.getAttribute('position'),n=geo.getAttribute('normal');
      const attributes={POSITION:attribute(p.array,'VEC3',p.count,5126,34962,limits),NORMAL:attribute(n.array,'VEC3',n.count,5126,34962)};
      const index=geo.index,indices=attribute(index.array,'SCALAR',index.count,index.array instanceof Uint32Array?5125:5123,34963);
      const m=mesh.material,material=file.materials.push({pbrMetallicRoughness:{baseColorFactor:[m.color.r,m.color.g,m.color.b,1],metallicFactor:m.metalness,roughnessFactor:m.roughness}})-1;
      const ref=file.meshes.push({primitives:[{attributes,indices,material}]})-1;
      const node=file.nodes.push({name,mesh:ref,translation:mesh.position.toArray(),rotation:mesh.quaternion.toArray(),scale:mesh.scale.toArray()})-1;
      file.scenes[0].nodes.push(node);
    }
    const bytes=new Uint8Array(length);
    for(const {offset,array} of raw)bytes.set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength),offset);
    let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    file.buffers=[{byteLength:length,uri:'data:application/octet-stream;base64,'+btoa(binary)}];return file;
  }
  add(data,notify=true){
    if(this.objects.size>=32)throw Error('场景最多放 32 个物体。');
    const id='obj-'+(++this.serial),shape=data.shape,position=data.position||[2.8,2.4,-.4],size=Number(data.size)||1;
    if(!['box','cylinder','sphere'].includes(shape)||!Array.isArray(position)||position.length!==3||!position.every(v=>Number.isFinite(v)&&Math.abs(v)<=12)||size<.2||size>2.5)throw Error('物体的位置或尺寸无效。');
    const r=size/2,color=Object.hasOwn(palette,data.color)?data.color:'jade';
    const geo=shape==='box'?new T.BoxGeometry(size,size,size):shape==='sphere'?new T.SphereGeometry(r,32,20):new T.CylinderGeometry(r,r,size,36);
    const collider=shape==='box'?new C.Box(new C.Vec3(r,r,r)):shape==='sphere'?new C.Sphere(r):new C.Cylinder(r,r,size,18);
    const mesh=new T.Mesh(geo,new T.MeshStandardMaterial({color:palette[color],roughness:.56,metalness:.08}));mesh.userData.id=id;mesh.castShadow=true;mesh.receiveShadow=true;
    const body=new C.Body({mass:1,shape:collider});body.position.set(...position);mesh.position.set(...position);
    if(Array.isArray(data.rotation)&&data.rotation.length===4&&data.rotation.every(Number.isFinite)){body.quaternion.set(...data.rotation).normalize();mesh.quaternion.copy(body.quaternion);}
    this.sim.addBody(body);this.scene.add(mesh);
    const name=typeof data.name==='string'&&data.name.trim()?data.name.trim().slice(0,20):({box:'方块',sphere:'球体',cylinder:'圆柱'}[shape]+this.serial);
    this.objects.set(id,{id,name,color,shape,size,mesh,body});this.selected=id;if(notify)this.changed();return this.objects.get(id);
  }
  select(id){if(this.objects.has(id)){this.selected=id;this.onChange?.();}}
  paint(id,color){const item=this.objects.get(id);if(!item||!Object.hasOwn(palette,color))throw Error('请选择物体和颜色。');item.mesh.material.color.setHex(palette[color]);item.color=color;this.changed();}
  move(id,position){
    const item=this.objects.get(id);if(!item||!Array.isArray(position)||position.length!==3||!position.every(v=>Number.isFinite(v)&&Math.abs(v)<=10)||position[1]<item.size/2)throw Error('位置超出工作区，或物体低于地面。');
    if(this.held===id)throw Error('请先松开机械臂。');
    item.body.position.set(...position);item.mesh.position.set(...position);item.body.velocity.setZero();item.body.angularVelocity.setZero();item.body.wakeUp();this.changed();
  }
  remove(id){const item=this.objects.get(id);if(!item||id===this.held||this.animation)return false;this.sim.removeBody(item.body);this.scene.remove(item.mesh);item.mesh.geometry.dispose();item.mesh.material.dispose();this.objects.delete(id);this.selected=this.objects.keys().next().value;this.changed();return true;}
  togglePhysics(){this.playing=!this.playing;if(!this.playing)this.changed();else this.onChange?.();}
  aim(position,joints){
    const [x,y,z]=position;const yaw=Math.atan2(z,x);
    let shoulder=joints?.[1];
    if(shoulder===undefined){const radial=Math.hypot(x,z),dy=y-.8,rr=Math.hypot(radial,dy);const angle=-Math.acos(Math.max(-1,Math.min(1,(rr*rr-2.15**2-1.75**2)/(2*2.15*1.75))));shoulder=Math.atan2(dy,radial)-Math.atan2(1.75*Math.sin(angle),2.15+1.75*Math.cos(angle));}
    const elbow=origin.clone().add(new T.Vector3(Math.cos(yaw)*Math.cos(shoulder),Math.sin(shoulder),Math.sin(yaw)*Math.cos(shoulder)).multiplyScalar(2.15));
    this.grip.set(x,y,z);segment(this.upper,origin,elbow);segment(this.lower,elbow,this.grip);this.joint.position.copy(elbow);this.claw.position.copy(this.grip);this.claw.rotation.y=-yaw;
    if(this.held){const obj=this.objects.get(this.held);obj.body.position.set(x,y-this.holdOffset,z);obj.mesh.position.copy(obj.body.position);}
  }
  animate(samples,done){if(this.animation)throw Error('机械臂正在移动。');const end=samples.at(-1);this.trace.geometry.dispose();this.trace.geometry=new T.BufferGeometry().setFromPoints(samples.map(s=>new T.Vector3(...s.position)));this.animation={samples,delta:0,end,done};}
  pick(id){if(this.held)throw Error('机械臂已经拿着物体。');const obj=this.objects.get(id);if(!obj)throw Error('没有找到要抓取的物体。');this.held=id;this.holdOffset=obj.size/2+.13;obj.body.type=C.Body.KINEMATIC;obj.body.updateMassProperties();obj.body.velocity.setZero();obj.body.angularVelocity.setZero();this.changed();}
  release(){if(!this.held)return false;const obj=this.objects.get(this.held);obj.body.type=C.Body.DYNAMIC;obj.body.updateMassProperties();obj.body.wakeUp();this.held=null;this.changed();return true;}
  refresh(){const r=this.distance*Math.cos(this.phi);this.camera.position.set(this.focus.x+r*Math.sin(this.theta),this.focus.y+this.distance*Math.sin(this.phi),this.focus.z+r*Math.cos(this.theta));this.camera.lookAt(this.focus);}
  bind(){
    const canvas=this.renderer.domElement;let down;
    canvas.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY,theta:this.theta,phi:this.phi};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{if(!down)return;this.theta=down.theta-(event.clientX-down.x)*.008;this.phi=Math.max(.12,Math.min(1.45,down.phi+(event.clientY-down.y)*.008));this.refresh();});
    canvas.addEventListener('pointercancel',()=>{down=null;});
    canvas.addEventListener('pointerup',event=>{
      if(down&&Math.hypot(event.clientX-down.x,event.clientY-down.y)<5){const r=canvas.getBoundingClientRect();this.pointer.set((event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2);this.rays.setFromCamera(this.pointer,this.camera);const hit=this.rays.intersectObjects([...this.objects.values()].map(o=>o.mesh))[0];if(hit)this.select(hit.object.userData.id);}
      down=null;
    });
    canvas.addEventListener('wheel',event=>{event.preventDefault();this.distance=Math.max(5,Math.min(28,this.distance+event.deltaY*.012));this.refresh();},{passive:false});
    new ResizeObserver(()=>{const w=this.el.clientWidth,h=this.el.clientHeight;if(w&&h){this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}}).observe(this.el);
  }
  draw(dt){
    if(this.animation){
      const m=this.animation;m.delta=Math.min(m.delta+dt,m.end.time);
      const index=Math.min(Math.floor(m.delta/m.end.time*(m.samples.length-1)),m.samples.length-2),a=m.samples[index],b=m.samples[index+1],f=(m.delta-a.time)/(b.time-a.time);
      this.arm=a.position.map((v,i)=>v+(b.position[i]-v)*f);this.aim(this.arm,a.joints.map((v,i)=>v+(b.joints[i]-v)*f));
      if(m.delta>=m.end.time){this.animation=null;m.done?.();}
    }
    if(this.playing){this.sim.step(1/60,dt,4);for(const obj of this.objects.values()){obj.mesh.position.copy(obj.body.position);obj.mesh.quaternion.copy(obj.body.quaternion);}}
    const item=this.objects.get(this.selected);this.selection.visible=Boolean(item);if(item)this.selection.setFromObject(item.mesh);
    this.renderer.render(this.scene,this.camera);
  }
}
