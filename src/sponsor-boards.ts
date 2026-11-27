import * as T from 'three';
import {batchParts} from './batch.ts';
import {railOffset,sampleAt,surveyMeters,type Station} from './track.ts';

const sponsors=[
  {name:'APEX',sub:'PERFORMANCE',ground:'#283036',ink:'#f4f1e7',stripe:'#f47b42'},
  {name:'KESTREL',sub:'MOTOR WORKS',ground:'#511829',ink:'#fff1dd',stripe:'#f3b46d'},
  {name:'TESSERA',sub:'TYRE COMPANY',ground:'#e6ad43',ink:'#282921',stripe:'#fff1cb'},
  {name:'OCTANT',sub:'LUBRICANTS',ground:'#15484a',ink:'#e9f6de',stripe:'#a4d7a7'},
  {name:'AXIAL',sub:'RACE SYSTEMS',ground:'#28435e',ink:'#e9f2f8',stripe:'#69bde5'},
];
function printMaterial(design:typeof sponsors[number]){
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle=design.ground;ctx.fillRect(0,0,1024,256);
  ctx.fillStyle=design.stripe;
  for(const x of [32,57]){
    ctx.beginPath();ctx.moveTo(x+50,20);ctx.lineTo(x+67,20);ctx.lineTo(x+13,236);ctx.lineTo(x-4,236);ctx.closePath();ctx.fill();
  }
  ctx.fillStyle=design.ink;ctx.font='italic 900 142px Arial, sans-serif';ctx.fillText(design.name,140,154,806);
  ctx.font='bold 46px Arial, sans-serif';ctx.letterSpacing='4px';ctx.fillText(design.sub,153,215,811);
  let seed=4305;
  const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<4200;i++){
    const x=random()*1024,y=random()*256;
    const opacity=.035+random()*.15*(y/256)**4;
    ctx.fillStyle=random()<.62?'rgba(65,53,43,'+opacity+')':'rgba(240,235,210,'+opacity+')';
    ctx.fillRect(x,y,random()*3+.5,random()*2.6+.4);
  }
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.anisotropy=8;
  return new T.MeshStandardMaterial({map:texture,roughness:.80,metalness:.06,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
}

export function addSponsorBoards(scene:T.Object3D,groundY:(x:number,z:number)=>number){
  const colors=sponsors.map(printMaterial);
  const galvanized=new T.MeshStandardMaterial({color:0x687274,metalness:.74,roughness:.45});
  function board(name:string,station:Station,offset:number,width:number,height:number,mat:number,attached=false,wallFacing?:number){
    const group=new T.Group();group.name=name+' '+sponsors[mat].name;
    const point=station.p.clone().addScaledVector(station.right,offset);
    group.position.copy(point);
    const facing=sampleAt(station.distance-22).p.sub(point);
    group.rotation.y=wallFacing??Math.atan2(facing.x,facing.z);
    scene.add(group);
    const part=(geo:T.BufferGeometry,material:T.Material,x:number,y:number,z:number)=>{
      const m=new T.Mesh(geo,material);m.position.set(x,y,z);m.receiveShadow=true;group.add(m);
    };
    part(new T.BoxGeometry(width,height,.066),galvanized,0,0,0);
    part(new T.PlaneGeometry(width-.044,height-.044),colors[mat],0,0,.054);
    for(const x of [-width*.39,width*.39]){
      if(wallFacing!==undefined)break;
      const support=new T.Vector3(x,0,0).applyAxisAngle(T.Object3D.DEFAULT_UP,group.rotation.y).add(point);
      const length=attached?.35:Math.max(.59,point.y-groundY(support.x,support.z)+.26);
      part(new T.BoxGeometry(.087,length,.095),galvanized,x,height*.22-length*.5,-.078);
    }
    batchParts(group);
  }
  for(const [i,stage,lateral,width,raise,brand,rail] of [
    [5,-74,-1,4.9,1.06,2,true],
    [9,-10,1,6.7,1.86,3,false],
    [14,22,-1,8.1,2.0,1,false],
    [18,-25,1,7.45,2.08,4,false],
    [27,25,-1,6.75,1.98,0,false],
    [33,-20,1,5.35,1.10,2,true],
    [35,20,1,8,2.24,3,false],
    [45,-29,-1,6.4,2.1,4,false],
    [49,22,1,6.75,2.2,1,false],
    [55,-35,-1,6.3,1.8,0,false],
    [63,-20,1,5.8,1.77,2,false],
    [68,17,-1,6.7,2.1,3,false],
  ] as const){
    const s=sampleAt(surveyMeters[i]+stage);
    s.p.y+=raise;
    board(rail?'Rail sponsor':'Trackside sponsor',s,(rail?railOffset+.53:railOffset+3.65)*lateral,width,rail?.85:1.68,brand,rail);
  }
  // The garage facade faces +X. Mount the second sign directly to the fascia.
  const wall=sampleAt(surveyMeters[2]-25);wall.p.set(-127.43,5.81,218);
  board('Pit wall sponsor',wall,0,5.25,.91,1,true,Math.PI/2);
}
