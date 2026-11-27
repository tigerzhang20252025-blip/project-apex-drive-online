import * as T from 'three';
import {batchParts} from './batch.ts';
import {startLine} from './track.ts';

export class StartSignal {
  count=0;
  phase:'idle'|'countdown'|'go'='idle';
  private elapsed=0;
  private hold=0;

  begin(random=Math.random){
    if(this.phase==='countdown')return false;
    this.elapsed=0;this.hold=.35+random()*1.30;
    this.count=0;this.phase='countdown';
    return true;
  }

  step(dt:number){
    if(this.phase==='idle')return;
    this.elapsed+=dt;
    if(this.phase==='countdown'){
      if(this.elapsed>=4.4+this.hold){
        this.count=0;this.phase='go';this.elapsed=0;
      }else this.count=Math.min(5,Math.floor(this.elapsed+.6));
    }else if(this.elapsed>=2)this.reset();
  }

  synchronize(remainingMs:number){
    if(remainingMs>0){
      this.phase='countdown';
      this.count=Math.min(5,Math.max(0,6-Math.ceil(remainingMs/1000)));
    }else if(remainingMs>-2000){
      this.phase='go';
      this.count=0;
    }else this.reset();
  }

  reset(){this.phase='idle';this.count=0;this.elapsed=0;}
}

export function installStartingGantry(scene:T.Object3D){
  const tower=new T.Group();
  tower.name='Apex start gantry';tower.position.copy(startLine.p);
  tower.rotation.y=Math.atan2(-startLine.forward.x,-startLine.forward.z);
  scene.add(tower);
  const steel=new T.MeshStandardMaterial({color:0x333a42,metalness:.64,roughness:.43});
  const zinc=new T.MeshStandardMaterial({color:0x697271,metalness:.64,roughness:.50});
  const concrete=new T.MeshStandardMaterial({color:0x96958c,roughness:.89});
  const hood=new T.MeshStandardMaterial({color:0x232528,metalness:.32,roughness:.62});
  const chrome=new T.MeshStandardMaterial({color:0x707477,metalness:.75,roughness:.31});
  const fixed=new T.Group();tower.add(fixed);
  function part(geo:T.BufferGeometry,mat:T.Material,x:number,y:number,z:number){
    const mesh=new T.Mesh(geo,mat);mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;
    fixed.add(mesh);return mesh;
  }
  const box=(w:number,h:number,d:number,mat:T.Material,x:number,y:number,z=0)=>part(new T.BoxGeometry(w,h,d),mat,x,y,z);
  for(const x of [-8.1,8.1]){
    box(.88,.50,1.03,concrete,x,.18);
    for(const z of [-.27,.27])box(.20,5.96,.19,steel,x,3.17,z);
    for(let i=0;i<5;i++)box(.14,1.28,.14,zinc,x,1.06+i*.98).rotation.x=(i%2?1:-1)*.46;
    for(const z of [-.34,.34])for(const dx of [-.31,.31])part(new T.CylinderGeometry(.035,.035,.053,6),chrome,x+dx,.445,z);
  }
  for(const y of [5.12,6.21])for(const z of [-.28,.28])box(16.55,.13,.13,steel,0,y,z);
  for(let i=0;i<14;i++){
    const x=(i-6.5)*1.166;
    for(const z of [-.26,.26])box(.094,1.63,.089,zinc,x,5.66,z).rotation.z=(i%2?1:-1)*.81;
    box(.08,.088,.64,zinc,x,6.18);
  }
  const canvas=document.createElement('canvas');canvas.width=1536;canvas.height=304;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#202930';ctx.fillRect(0,0,1536,304);
  ctx.fillStyle='#f07437';ctx.fillRect(47,48,21,208);
  ctx.fillStyle='#f6efe0';ctx.font='italic 900 141px Arial, sans-serif';ctx.fillText('APEX',103,190);
  ctx.font='bold 51px Arial, sans-serif';ctx.fillText('ALPINE PROVING GROUND',620,170,827);
  const logo=new T.CanvasTexture(canvas);logo.colorSpace=T.SRGBColorSpace;logo.anisotropy=8;
  box(6.22,1.26,.073,steel,0,5.65,.36);
  part(new T.PlaneGeometry(6.19,1.23),new T.MeshStandardMaterial({map:logo,roughness:.82}),0,5.65,.40);
  box(.43,.59,.33,hood,7.91,2.24,.41);
  box(.36,.51,.036,zinc,7.91,2.24,.60);
  box(.49,.19,.30,hood,-7.82,4.68,.35).rotation.y=-.28;
  const signal=new StartSignal();
  const lenses:T.MeshStandardMaterial[]=[];
  const lensTexture=document.createElement('canvas');lensTexture.width=lensTexture.height=128;
  const LEDs=lensTexture.getContext('2d')!;
  LEDs.fillStyle='#6b160a';LEDs.fillRect(0,0,128,128);
  for(let y=9;y<128;y+=11)for(let x=9;x<128;x+=11){
    LEDs.fillStyle=(x+y)%3===0?'#ffaf76':'#e96441';
    LEDs.beginPath();LEDs.arc(x,y,3.35,0,2*Math.PI);LEDs.fill();
  }
  const clusters=new T.CanvasTexture(lensTexture);clusters.colorSpace=T.SRGBColorSpace;
  for(let i=0;i<5;i++){
    const x=(i-2)*.75;
    box(.45,.79,.25,hood,x,4.71,.31);
    box(.20,.27,.20,steel,x,5.22,.20);
    const lens=new T.MeshStandardMaterial({map:clusters,color:0x612e29,emissive:0xff2d19,emissiveMap:clusters,emissiveIntensity:0,roughness:.35});
    lenses.push(lens);
    for(const y of [4.55,4.87]){
      part(new T.CylinderGeometry(.146,.146,.12,24).rotateX(Math.PI/2),hood,x,y,.49);
      part(new T.TorusGeometry(.123,.015,8,28),chrome,x,y,.55);
      const face=new T.Mesh(new T.CircleGeometry(.115,36),lens);face.name='Start red '+(i+1);face.position.set(x,y,.555);tower.add(face);
      part(new T.CylinderGeometry(.133,.133,.083,22,1,true,.0,Math.PI).rotateX(Math.PI/2),hood,x,y,.589);
      for(const dx of [-.181,.181])part(new T.CylinderGeometry(.013,.013,.005,6).rotateX(Math.PI/2),zinc,x+dx,y,.440);
    }
  }
  batchParts(fixed);
  let previous=-1;
  return {
    signal,
    sync(){
      if(previous===signal.count)return;previous=signal.count;
      lenses.forEach((lens,i)=>{
        lens.emissiveIntensity=i<signal.count?3.4:0;
        lens.color.setHex(i<signal.count?0xf38d76:0x51241e);
      });
    },
  };
}
