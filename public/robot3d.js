import * as T from './vendor/three.module.js';

const pet = document.querySelector('#pet');
const stage = pet.querySelector('.robot-stage');
const motion = document.querySelector('#motion');
const color = document.querySelector('#color');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const expressions = {
  warm:      { tint: '#ffb75c', left: 1, right: 1, tilt: 0, arc: 0 },
  joy:       { tint: '#ffc468', left: .54, right: .54, tilt: .06, arc: 1 },
  calm:      { tint: '#a8e3b9', left: .27, right: .27, tilt: -.035, arc: 0 },
  curious:   { tint: '#d6b8ff', left: .78, right: 1.24, tilt: -.13, arc: 0 },
  support:   { tint: '#a4d5ff', left: .72, right: .72, tilt: .09, arc: 0 },
  celebrate: { tint: '#ffa3ca', left: .56, right: .56, tilt: -.07, arc: 1 },
};

function mount() {
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(32, 1, .1, 70);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.6));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  stage.append(renderer.domElement);

  scene.add(new T.HemisphereLight(0xfff5e6, 0x8a8978, 2.4));
  const light = (c, strength, x,y,z) => {
    const l=new T.DirectionalLight(c,strength); l.position.set(x,y,z); scene.add(l);
  };
  light(0xffedd0, 3.3, -4,6,4);
  light(0xfff5eb, 1.85, 3,4,-4);
  light(0xddedff, .65, 4,1,3);

  const rig=new T.Group(), toy=new T.Group();
  rig.position.y=1.14; toy.position.y=-1.14; rig.add(toy); scene.add(rig);
  function canvas(w,h) {
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    return [c,c.getContext('2d')];
  }
  function grain(knit) {
    const [c,x]=canvas(128,128), pix=x.createImageData(128,128);
    let seed=419;
    for(let i=0;i<128*128;i++){
      seed=(1664525*seed+1013904223)>>>0;
      const px=i%128, py=i>>7;
      const weave=knit ? Math.cos(px*Math.PI/4 + 1.4*Math.sin(py*Math.PI/8))*Math.sin(py*Math.PI/4)*29 : 0;
      pix.data.set([128+weave+(seed%63)-31,128+weave+(seed%63)-31,128+weave+(seed%63)-31,255],i*4);
    }
    x.putImageData(pix,0,0);
    const tex=new T.CanvasTexture(c); tex.wrapS=tex.wrapT=T.RepeatWrapping;
    tex.repeat.set(knit?9:5,knit?3:5); return tex;
  }
  const ceramic=new T.MeshStandardMaterial({color:0xe4d0b5,roughness:.84,bumpMap:grain(false),bumpScale:.016});
  const fabric=new T.MeshStandardMaterial({color:0x636d46,roughness:1,bumpMap:grain(true),bumpScale:.045});
  const sage=new T.MeshStandardMaterial({color:0x737e56,roughness:.76});
  const dark=new T.MeshStandardMaterial({color:0x231d18,roughness:.6});
  const warm=new T.MeshStandardMaterial({color:0xb56348,roughness:.7});
  const sphere=new T.SphereGeometry(1,48,32);
  const mesh=(geo,mat,x,y,z)=>{const m=new T.Mesh(geo,mat);m.position.set(x,y,z);toy.add(m);return m;};
  const oval=(mat,x,y,z,sx,sy,sz)=>{const m=mesh(sphere,mat,x,y,z);m.scale.set(sx,sy,sz);return m;};
  function shell(profile,mat) {
    const curve=new T.SplineCurve(profile.map(([r,y])=>new T.Vector2(r,y)));
    const m=mesh(new T.LatheGeometry(curve.getPoints(78).map(p=>new T.Vector2(Math.max(0,p.x),p.y)),84),mat,0,0,0);
    m.scale.z=.78;return m;
  }
  shell([[0,.045],[.66,.045],[.9,.11],[1.04,.25],[1.13,.48],[1.16,.57]],fabric);
  shell([[0,.55],[.98,.55],[1.16,.57],[1.21,.8],[1.2,1.1],[1.13,1.5],[1.03,1.88],[.88,2.17],[.67,2.36],[.35,2.44],[0,2.45]],ceramic);
  oval(ceramic,-.69,2.26,-.03,.34,.55,.32).rotation.z=.39;
  oval(ceramic,.69,2.26,-.03,.34,.55,.32).rotation.z=-.39;
  oval(sage,0,2.448,.015,.255,.058,.22);

  const [face,ctx]=canvas(768,448);
  const display=new T.CanvasTexture(face);
  display.colorSpace=T.SRGBColorSpace;
  const screen=new T.MeshBasicMaterial({map:display,toneMapped:false,side:T.DoubleSide});
  function visor(w,h,z,mat) {
    const geo=new T.PlaneGeometry(2,2,48,32),pos=geo.attributes.position;
    for(let i=0;i<pos.count;i++){
      const px=pos.getX(i),py=pos.getY(i), r=Math.max(Math.abs(px),Math.abs(py));
      const n=(Math.abs(px)**3+Math.abs(py)**3)**(1/3) || 1;
      const x=px*r/n,y=py*r/n;
      pos.setXYZ(i,x*w,y*h,z-.22*x*x-.135*y*y-.024*y);
    }
    geo.computeVertexNormals();
    return mesh(geo,mat,0,1.715,0);
  }
  visor(.864,.488,.961,dark);
  visor(.845,.466,.974,screen);
  for(const x of [-.59,.59]) oval(dark,x,1.07,.813,.064,.021,.019);
  const slider=oval(warm,1.012,1.5,.48,.076,.175,.045); slider.rotation.y=.77;
  const knob=oval(sage,1.036,1.416,.51,.087,.086,.057);knob.rotation.y=.77;

  const [shadow,sh]=canvas(128,128);
  const g=sh.createRadialGradient(64,64,8,64,64,63);
  g.addColorStop(0,'rgba(49,39,27,.35)');g.addColorStop(1,'rgba(49,39,27,0)');
  sh.fillStyle=g;sh.fillRect(0,0,128,128);
  const mat=new T.MeshBasicMaterial({map:new T.CanvasTexture(shadow),transparent:true,depthWrite:false});
  const ground=new T.Mesh(new T.PlaneGeometry(3.45,2.5),mat);
  ground.rotation.x=-Math.PI/2; scene.add(ground);

  const pointer={x:0,y:0};
  let lastTouch=-10, raf=0, visible=true, lost=false, faceKey='', start=performance.now();
  const living=new T.Color(expressions.warm.tint);
  const target=new T.Color();
  const faceState={l:1,r:1,arc:0};
  const ease=(a,b,t)=>a+(b-a)*t;
  function drawFace(l,r,arc,ex,ey,tint,thinking,t){
    const key=[l.toFixed(2),r.toFixed(2),arc.toFixed(2),Math.round(ex),Math.round(ey),tint,thinking?Math.round(t*12):0].join('/');
    if(key===faceKey)return;
    faceKey=key;
    const bg=ctx.createLinearGradient(0,0,768,448);
    bg.addColorStop(0,'#2e2721');bg.addColorStop(.50,'#1d1713');bg.addColorStop(1,'#100e0c');
    ctx.fillStyle=bg;ctx.fillRect(0,0,768,448);
    const shine=ctx.createLinearGradient(0,0,365,230);
    shine.addColorStop(0,'rgba(255,246,230,.24)');shine.addColorStop(1,'rgba(255,246,230,0)');
    ctx.fillStyle=shine;ctx.beginPath();
    ctx.moveTo(0,0);ctx.lineTo(412,0);ctx.bezierCurveTo(278,40,207,112,24,192);ctx.lineTo(0,193);ctx.fill();
    for(const [i,h] of [l,r].entries()){
      ctx.save();ctx.translate((i?524:244)+ex,218+ey);
      ctx.strokeStyle=ctx.fillStyle=tint;ctx.shadowColor=tint;ctx.shadowBlur=27;ctx.lineCap='round';
      if(arc>.55 && h>.16){
        ctx.lineWidth=20;ctx.beginPath();ctx.moveTo(-22,6);ctx.quadraticCurveTo(0,-30,22,6);ctx.stroke();
      }else{
        const hh=Math.max(7,95*h);
        ctx.beginPath();ctx.roundRect(-24,-hh/2,48,hh,Math.min(hh/2,24));ctx.fill();
      }
      ctx.restore();
    }
    if(thinking){
      for(let i=0;i<3;i++){ctx.globalAlpha=.24+.65*Math.max(0,Math.sin(t*6-i));ctx.fillStyle=tint;
        ctx.beginPath();ctx.arc(354+30*i,344,5,0,Math.PI*2);ctx.fill();}
      ctx.globalAlpha=1;
    }
    display.needsUpdate=true;
  }
  function size(){
    const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;
    renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
    camera.position.set(2.25,2.65,6.65*Math.max(1,.87/camera.aspect));camera.lookAt(0,1.39,0);
  }
  function frame(now){
    raf=0;if(lost||!visible||document.hidden)return;
    const t=(now-start)/1000, animate=motion.checked&&!reduced.matches;
    const key=pet.dataset.expression || [...pet.classList].find(c=>c in expressions) || 'warm';
    const e=expressions[key]||expressions.warm, thinking=pet.dataset.activity==='thinking';
    const elapsed=t-lastTouch;
    const bounce=animate && elapsed>=0 && elapsed<.65 ? Math.sin(elapsed/.65*Math.PI)*.17 : 0;
    const blink=animate?1-.92*Math.max(0,1-Math.abs(((t+.35)%4.37)-3.84)/.12):1;
    const k=animate?.18:1;
    rig.rotation.y=ease(rig.rotation.y,animate?.16*pointer.x+.035*Math.sin(t*.7):0,k);
    rig.rotation.z=ease(rig.rotation.z,animate?e.tilt+.024*Math.sin(t*1.45):0,k);
    rig.rotation.x=ease(rig.rotation.x,animate?-.08*pointer.y:0,k);
    rig.position.y=1.14+(animate?.021*Math.sin(t*2.05)+bounce:0);
    faceState.l=ease(faceState.l,e.left,k);faceState.r=ease(faceState.r,e.right,k);
    faceState.arc=ease(faceState.arc,e.arc,k);
    living.lerp(target.set(color.checked?e.tint:'#ffbc73'),k);
    drawFace(faceState.l*blink,faceState.r*blink,faceState.arc,animate?pointer.x*30:0,animate?pointer.y*19:0,'#'+living.getHexString(),thinking,animate?t:0);
    renderer.render(scene,camera);
    stage.dataset.ready='true';
    if(animate)schedule();
  }
  function schedule(){if(!raf&&!lost&&visible&&!document.hidden)raf=requestAnimationFrame(frame);}
  new ResizeObserver(()=>{size();schedule();}).observe(stage);
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;schedule();}).observe(pet);
  new MutationObserver(schedule).observe(pet,{attributes:true,attributeFilter:['class','data-activity','data-expression']});
  for(const e of [motion,color,reduced])e.addEventListener('change',schedule);
  document.addEventListener('visibilitychange',schedule);
  pet.addEventListener('pointermove',e=>{const r=stage.getBoundingClientRect();pointer.x=(e.clientX-r.left)/r.width*2-1;pointer.y=(e.clientY-r.top)/r.height*2-1;});
  pet.addEventListener('pointerleave',()=>{pointer.x=pointer.y=0;});
  pet.addEventListener('click',()=>{lastTouch=(performance.now()-start)/1000;schedule();});
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;delete stage.dataset.ready;});
  renderer.domElement.addEventListener('webglcontextrestored',()=>{lost=false;schedule();});
  size();schedule();
}

try { mount(); } catch {
  stage.replaceChildren();
  stage.dataset.unavailable='true';
}
