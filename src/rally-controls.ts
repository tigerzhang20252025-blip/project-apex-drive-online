import * as T from 'three';
import {bevel,part,rallyMat,rallyMetal} from './rally-details.ts';
import {batchParts} from './batch.ts';
import type {Switch} from './f40-cabin.ts';
import type {Vehicle} from './vehicle.ts';

export const rallyControlHints:Partial<Record<Switch,string>>={
  ignition:'Engine start / stop',
  light:'Headlights · rotate end collar',
  left:'Left turn signal',
  right:'Right turn signal',
  wiper:'Wipers · Off / Low / High',
  hazard:'Hazard lights',
  popup:'Auxiliary lamps',
  transmission:'Automatic / Manual · vehicle stopped',
  traction:'Traction control',
  dial:'Instrument brightness',
  'shift-up':'Upshift · manual mode',
  'shift-down':'Downshift · manual mode',
};

export function hitArea(parent:T.Object3D,targets:T.Mesh[],action:Switch,box:[number,number,number],x=0,y=0,z=0){
  const target=new T.Mesh(new T.BoxGeometry(...box),new T.MeshBasicMaterial({visible:false}));
  target.name='R35 control: '+action;
  target.position.set(x,y,z);target.userData.action=action;
  parent.add(target);targets.push(target);
  return target;
}

export function engravedFace(text:string,color='#c0bdb2',background='#242626'){
  const canvas=document.createElement('canvas');canvas.width=192;canvas.height=100;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle=background;ctx.fillRect(0,0,192,100);
  ctx.fillStyle=color;ctx.font='600 56px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(text,96,51,177);
  const map=new T.CanvasTexture(canvas);map.colorSpace=T.SRGBColorSpace;map.anisotropy=4;
  return new T.MeshStandardMaterial({map,roughness:.79});
}

function pivot(parent:T.Object3D,name:string,x:number,y:number,z:number,tilt=0){
  const group=new T.Group();group.name=name;group.position.set(x,y,z);group.rotation.x=tilt;parent.add(group);return group;
}

// The stock GLB combines the starter and shifter with the dash's material
// meshes. Separate only the triangles belonging to those existing controls.
function detachDashPart(body:T.Group,cabin:T.Group,group:T.Group,min:number[],max:number[]){
  const bounds=new T.Box3(new T.Vector3(...min),new T.Vector3(...max));
  const inverse=cabin.matrixWorld.clone().invert(),p=new T.Vector3();
  let pieces=0;
  const sourceNames=['plastic','interior','leather'];
  for(const key of sourceNames){
    const mesh=body.getObjectByName('r35_dash_2017_r35_'+key+'_0');
    if(!(mesh instanceof T.Mesh)||!mesh.geometry.index)continue;
    const matrix=inverse.clone().multiply(mesh.matrixWorld),geo=mesh.geometry, index=geo.index!;
    const attribute=geo.getAttribute('position');
    const mask=Array.from({length:attribute.count},(_,i)=>bounds.containsPoint(p.fromBufferAttribute(attribute,i).applyMatrix4(matrix)));
    const rest:number[]=[],moving:number[]=[];
    for(let i=0;i<index.count;i+=3){
      const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2);
      (mask[a]&&mask[b]&&mask[c]?moving:rest).push(a,b,c);
    }
    if(!moving.length)continue;
    const piece=mesh.clone(false);piece.geometry=geo.clone().setIndex(moving);
    geo.setIndex(rest);
    mesh.parent!.add(piece);group.attach(piece);
    pieces++;
  }
  if(!pieces)throw Error('Missing integrated R35 control geometry: '+group.name);
}

export function buildRallyControls(body:T.Group,parent:T.Group,targets:T.Mesh[]){
  const rubber=rallyMat(0x262628,.77),plastic=rallyMat(0x222527,.63),aluminium=rallyMetal(0x777b7c,.47);
  const red=rallyMat(0x692f2b,.72);
  const cylinder=(radius:number,depth:number,axis:'x'|'z'='z')=>{
    const g=new T.CylinderGeometry(radius,radius,depth,22);
    return axis==='z'?g.rotateX(Math.PI/2):g.rotateZ(Math.PI/2);
  };
  const fastener=new T.CylinderGeometry(.0021,.0021,.0016,6).rotateX(Math.PI/2);
  const start=pivot(parent,'R35 stock engine starter',-.0683,.6307,.060);
  const selector=pivot(parent,'R35 stock gear selector',-.018,.640,-.154);
  parent.updateWorldMatrix(true,true);
  detachDashPart(body,parent,start,[-.088,.6284,.040],[-.048,.6337,.080]);
  detachDashPart(body,parent,selector,[-.046,.633,-.177],[.011,.737,-.104]);
  const legend=document.createElement('canvas');legend.width=legend.height=128;
  const ink=legend.getContext('2d')!;
  const paint=ink.createLinearGradient(0,0,0,128);
  paint.addColorStop(0,'#872e27');paint.addColorStop(1,'#501b17');
  ink.fillStyle=paint;ink.fillRect(0,0,128,128);
  ink.strokeStyle='#a45445';ink.lineWidth=3;
  ink.beginPath();ink.arc(64,64,59,0,Math.PI*2);ink.stroke();
  ink.fillStyle='#f3e6d8';ink.font='700 19px system-ui';
  ink.textAlign='center';ink.textBaseline='middle';
  for(const [index,line] of ['ENGINE','START','STOP'].entries())ink.fillText(line,64,42+22*index,88);
  const startMap=new T.CanvasTexture(legend);startMap.colorSpace=T.SRGBColorSpace;startMap.anisotropy=4;
  const startMaterial=new T.MeshStandardMaterial({
    map:startMap,roughness:.59,emissive:0xffffff,emissiveMap:startMap,emissiveIntensity:.18,
  });
  const startFace=part(start,new T.CircleGeometry(.0139,36).rotateX(-Math.PI/2),startMaterial,0,.0018,0);
  startFace.castShadow=false;
  hitArea(start,targets,'ignition',[.048,.020,.048],0,.004,0);
  const selectorTrim=part(selector,new T.PlaneGeometry(.023,.009),engravedFace('A/M'),.002,.062,.0435);
  selectorTrim.rotation.x=-.35;selectorTrim.castShadow=false;
  hitArea(selector,targets,'transmission',[.066,.067,.063],.002,.057,.013);

  const hazard=pivot(parent,'R35 hazard switch',.0018,.7875,-.2358,-.16);
  part(hazard,bevel(.020,.017,.006,.0025),plastic);
  const triangle=new T.Shape().moveTo(0,.0045).lineTo(-.005,-.0035).lineTo(.005,-.0035).closePath();
  const detail=part(hazard,new T.ShapeGeometry(triangle),red,0,0,.0032);detail.castShadow=false;
  hitArea(hazard,targets,'hazard',[.035,.027,.018],0,0,.004);

  const setup=[
    {action:'popup',label:'AUX',x:-.077,z:-.2425},
    {action:'traction',label:'TC',x:.079,z:-.2219},
  ] as const;
  const rockers=setup.map(({x,z,action,label})=>{
    const toggle=pivot(parent,'R35 '+label+' rocker',x,.6616,z,-.30);
    part(toggle,bevel(.021,.017,.009,.0024),rubber);
    part(toggle,new T.PlaneGeometry(.0175,.0083),engravedFace(label),0,-.0006,.0047).castShadow=false;
    const led=new T.MeshStandardMaterial({color:0x755736,emissive:0xad713b,emissiveIntensity:0,roughness:.55});
    part(toggle,bevel(.007,.0016,.0008,.0003),led,0,.0059,.0048).castShadow=false;
    hitArea(toggle,targets,action,[.040,.030,.024],0,0,.006);
    return {action,toggle,led};
  });

  const dimmer=pivot(parent,'R35 meter rheostat',-.619,.796,-.313,-.16);
  part(dimmer,cylinder(.0105,.004),aluminium,0,0,-.0015);
  const dimKnob=new T.Group();dimmer.add(dimKnob);
  part(dimKnob,cylinder(.008,.010),rubber,0,0,.004);
  for(let i=0;i<12;i++){
    const a=i*Math.PI/6;
    const flute=part(dimKnob,bevel(.0012,.002,.008,.0005),plastic,Math.cos(a)*.008,Math.sin(a)*.008,.003);
    flute.rotation.z=a;
  }
  part(dimKnob,bevel(.0015,.005,.001,.0004),aluminium,0,.004,.0096).castShadow=false;
  hitArea(dimmer,targets,'dial',[.036,.032,.024],0,0,.009);

  const left=pivot(parent,'R35 combination stalk',-.46,.873,-.271);
  const stockLeft:T.Mesh[]=[];
  body.traverse(node=>{
    if(!(node instanceof T.Mesh))return;
    if(node.name.startsWith('r35_signalstalk_2017_'))stockLeft.push(node);
    else if(node.name.startsWith('r35_signalstalk_r35_'))node.visible=false;
  });
  if(!stockLeft.length)throw Error('Missing factory GT-R stalk');
  for(const mesh of stockLeft)left.attach(mesh);
  const collar=pivot(left,'R35 headlamp collar',-.137,.014,.018);
  part(collar,cylinder(.0121,.037,'x'),rubber);
  for(const x of [-.017,-.010,.012,.017])part(collar,cylinder(.013,.0015,'x'),plastic,x);
  const lightMark=part(collar,new T.PlaneGeometry(.021,.010),engravedFace('LAMP'),0,.001,.0123);
  lightMark.castShadow=false;
  hitArea(collar,targets,'light',[.039,.032,.030],-.006,0,.007);
  hitArea(left,targets,'left',[.036,.019,.040],-.090,.034,.026);
  hitArea(left,targets,'right',[.036,.019,.040],-.090,-.005,.025);

  const right=pivot(parent,'R35 wiper stalk',-.279,.883,-.255);
  const arm=new T.CylinderGeometry(.0072,.010,.098,20).rotateZ(-Math.PI/2);
  part(right,arm,plastic,.043,0,0);
  part(right,cylinder(.0128,.020,'x'),rubber,.094,.003,.004);
  const wipeKnob=pivot(right,'R35 wipe speed collar',.121,.004,.005);
  part(wipeKnob,cylinder(.012,.038,'x'),rubber);
  for(const x of [-.016,-.010,.012,.017])part(wipeKnob,cylinder(.0128,.0014,'x'),plastic,x);
  part(wipeKnob,new T.PlaneGeometry(.027,.0095),engravedFace('WIPE'),0,0,.0125).castShadow=false;
  hitArea(wipeKnob,targets,'wiper',[.056,.036,.035],-.002,.004,.009);
  for(const x of [-.0076,.0076])part(hazard,fastener,plastic,x,-.0062,.0023).castShadow=false;
  for(const moving of [dimmer,dimKnob,collar,wipeKnob])batchParts(moving);

  const last=new Map<Switch,number>();
  const push=(action:Switch,now:number,duration=175)=>{
    const t=T.MathUtils.clamp((now-(last.get(action)??-10000))/duration,0,1);
    return Math.sin(t*Math.PI);
  };
  let lastTick=performance.now();
  return {
    trigger(action:Switch){last.set(action,performance.now());},
    sync(car:Vehicle,aux:boolean,brightness:number){
      const now=performance.now(),dt=Math.min(.06,(now-lastTick)/1000);lastTick=now;
      const ease=(current:number,target:number)=>T.MathUtils.damp(current,target,18,dt);
      start.position.y=.6307-.0022*push('ignition',now);
      hazard.position.z=-.2358-.0024*push('hazard',now);
      selector.rotation.z=-.037*Number(!car.automatic)-.085*push('transmission',now);
      dimKnob.rotation.z=ease(dimKnob.rotation.z,-1.4+brightness*2.55);
      const turn=car.turn===1?.16:car.turn===-1?-.16:0;
      left.rotation.z=ease(left.rotation.z,turn);
      collar.rotation.x=ease(collar.rotation.x,car.lights?.48:0);
      const mode=car.wiper.mode==='HIGH'?2:car.wiper.mode==='LOW'?1:0;
      wipeKnob.rotation.x=ease(wipeKnob.rotation.x,.52*mode);
      right.rotation.z=.087*push('wiper',now);
      red.color.setHex(car.turn===2&&car.blink?0xad4b40:0x692f2b);
      for(const {action,toggle,led} of rockers){
        const on=action==='popup'?aux:car.tractionControl;
        toggle.rotation.x=-.30+(on?-.061:.032)-.14*push(action,now);
        led.emissiveIntensity=on?.30:0;
      }
    },
  };
}
