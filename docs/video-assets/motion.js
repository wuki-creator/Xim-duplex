// Original previsualization for the ChatCut edit. Canvas is 1280 × 720.
// `character` is the transparent PNG of the project's own Three.js character.
window.renderXimFilm=(canvas,character,t)=>{
 const c=canvas.getContext('2d'),W=1280,H=720;
 const ink='#eaf5f2',muted='#8dabb3',cyan='#8addde',amber='#f6c273';
 const ease=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
 const text=(s,x,y,size=24,color=ink,weight=400)=>{c.fillStyle=color;c.font=weight+' '+size+'px "Microsoft YaHei", sans-serif';c.fillText(s,x,y);};
 const line=(x,y,x2,y2,color='#7ed8df33')=>{c.strokeStyle=color;c.lineWidth=1;c.beginPath();c.moveTo(x,y);c.lineTo(x2,y2);c.stroke();};
 const panel=(x,y,w,h)=>{c.fillStyle='#17333bcc';c.strokeStyle='#8acbd73a';c.lineWidth=1;c.beginPath();c.roundRect(x,y,w,h,20);c.fill();c.stroke();};
 const wave=(x,y,w,color,phase=0,amp=1)=>{c.strokeStyle=color;c.lineWidth=2;c.beginPath();for(let i=0;i<=w;i++){const a=(Math.sin(i*.038+t*4+phase)*Math.sin(i*.011+t*1.5+phase)+Math.sin(i*.12-t*3)*.2)*20*amp;const yy=y+a*Math.sin(Math.PI*i/w);i?c.lineTo(x+i,yy):c.moveTo(x,yy);}c.stroke();};
 const ring=(x,y,r,opacity=1)=>{c.save();c.globalAlpha=opacity;c.strokeStyle='#96dae834';c.lineWidth=1;c.beginPath();c.ellipse(x,y,r,r*.34,0,0,Math.PI*2);c.stroke();c.restore();};
 c.clearRect(0,0,W,H);const bg=c.createLinearGradient(0,0,W,H);bg.addColorStop(0,'#071820');bg.addColorStop(.6,'#102a31');bg.addColorStop(1,'#071519');c.fillStyle=bg;c.fillRect(0,0,W,H);
 const glow=c.createRadialGradient(930,330,20,930,330,430);glow.addColorStop(0,'#4c929033');glow.addColorStop(1,'#07202a00');c.fillStyle=glow;c.fillRect(0,0,W,H);
 for(let i=0;i<14;i++){let x=(i*110+t*7)%1480-100;line(x,0,x-190,H,'#90d3e909');}for(let i=0;i<9;i++)line(0,i*90+20,W,i*90+20,'#90d3e908');
 text('XIM',58,61,21,ink,700);text('/  DUPLEX',116,61,15,muted,400);line(58,80,1222,80,'#90d3e92b');
 text('交互概念演示',1100,60,14,muted);text('伴点 · 个人陪伴空间',58,678,14,muted);text('独立级联原型',1110,678,14,muted);
 const stage=t<5?0:t<12?1:t<19?2:t<24?3:4;
 const starts=[0,5,12,19,24],ends=[5,12,19,24,26];const local=t-starts[stage];const fade=ease(local/.65)*ease((ends[stage]-t)/.4);
 c.save();c.globalAlpha=fade;
 const bob=Math.sin(t*1.6)*7;
 if(stage===0||stage===4){
  text(stage===0?'持续倾听，':'对话，',72,268,58,ink,600);text(stage===0?'自然回应。':'由你掌控。',72,349,58,ink,600);
  text(stage===0?'开口的每一刻，都值得被听见。':'Xim · 伴点',76,410,22,muted);
  text('FULL-DUPLEX  /  EMOTIONAL COMPANION',76,487,14,cyan,500);
  ring(935,545,250);ring(935,545,205);c.drawImage(character,660,115+bob,540,481);wave(800,609,270,amber,0,.35);
 }else if(stage===1){
  text('说与听，同时发生。',72,181,44,ink,600);
  panel(72,228,638,140);text('你',96,266,16,cyan);text('今天有点累，陪我聊聊吧。',96,310,30,ink);
  panel(72,392,638,157);text('伴点 · 陪伴',96,430,16,amber);text('今天不太轻松吧。',96,476,28,'#bfddfa');text('我在听，想说什么都可以。',96,518,28,'#bfddfa');
  c.drawImage(character,785,220+bob,380,339);ring(975,565,170);wave(775,591,398,cyan);wave(775,624,398,amber,2,.65);text('持续收听',807,181,19,cyan);text('可被打断的回应',985,181,19,amber);
 }else if(stage===2){
  text('你插话，我先听。',72,181,44,ink,600);
  panel(72,231,690,104);text('等一下，先听我说。',97,296,33,ink,500);
  const quiet=ease(local/1.2);wave(100,390,630,amber,0,1-quiet);text('旧回应停止',98,439,18,muted);
  if(local>1.3){c.save();c.globalAlpha*=ease((local-1.3)/.7);panel(72,477,690,95);text('好的，你慢慢说。',98,536,32,'#bfddfa');c.restore();}
  c.drawImage(character,817,235+bob,350,312);ring(990,561,160);wave(837,603,320,cyan,0,.5);
 }else{
  text('让反馈，引导改进。',72,187,44,ink,600);
  text('听见你的偏好，也检验每一次变化。',76,241,22,muted);
  const names=['表达','反馈','评估','迭代'];for(let i=0;i<4;i++){const x=167+i*312;const strength=ease((local-i*.5)/.7);c.save();c.globalAlpha*=.25+.75*strength;c.fillStyle=i===2?amber:cyan;c.beginPath();c.arc(x,402,7,0,Math.PI*2);c.fill();text(names[i],x-34,467,31,ink,500);text(['真实对话','自愿评价','独立比较','保留旧版'][i],x-38,505,18,muted);if(i<3)line(x+22,402,x+288,402,'#8addde60');c.restore();}
  text('通过评估，再更新当前策略',76,600,18,cyan);
 }
 c.restore();c.fillStyle='#8addde55';c.fillRect(58,699,1164*Math.min(1,t/26),2);
};
