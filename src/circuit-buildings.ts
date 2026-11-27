import * as T from 'three';
import {batchParts} from './batch.ts';
import {stations} from './track.ts';

const concrete=new T.MeshStandardMaterial({color:0xb2afa4,roughness:.93});
const metal=new T.MeshStandardMaterial({color:0x627076,metalness:.60,roughness:.43});
const dark=new T.MeshStandardMaterial({color:0x303c41,roughness:.77});
const glazing=new T.MeshPhysicalMaterial({color:0x47656d,roughness:.23,metalness:.28,clearcoat:.55});
const warm=new T.MeshStandardMaterial({color:0xaa432a,metalness:.36,roughness:.55});
const cube=new T.BoxGeometry();
function block(g:T.Group,x:number,y:number,z:number,w:number,h:number,d:number,m:T.Material){
  const item=new T.Mesh(cube,m);item.position.set(x,y,z);item.scale.set(w,h,d);g.add(item);return item;
}
function strut(g:T.Group,from:T.Vector3,to:T.Vector3,size:number,mat:T.Material){
  const item=new T.Mesh(cube,mat);item.position.lerpVectors(from,to,.5);
  item.scale.set(size,from.distanceTo(to),size);
  item.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),to.clone().sub(from).normalize());g.add(item);
}
function sign(g:T.Group,map:T.Texture,x:number,y:number,z:number,w:number,h:number,angle:number){
  const m=new T.Mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({map}));m.position.set(x,y,z);m.rotation.y=angle;g.add(m);
}
export function buildPaddock(scene:T.Object3D, signTexture:(a:string,b:string,dark?:boolean)=>T.Texture) {
  const pit=new T.Group();pit.position.set(-132,1.57,201);scene.add(pit);
  // Retaining plinth rises to the level of the main straight, garage doors face the apron.
  block(pit,0,-1.76,0,26,3.5,81,concrete);
  block(pit,0,-.025,0,26,.09,81,dark);
  block(pit,-3,2.05,0,11.5,4.1,61,concrete);
  block(pit,-3,4.35,0,12.6,.52,62,dark);
  block(pit,3.2,3.90,0,2.5,.18,62,metal);
  for(let i=0;i<9;i++){
    const z=-26+i*6.5;
    block(pit,2.78,1.82,z,.13,3.35,5.6,metal);
    for(let j=0;j<9;j++)block(pit,2.86,.30+j*.34,z,.065,.023,5.5,dark);
    block(pit,2.89,2.54,z,.09,.47,4.7,glazing);
    block(pit,3.04,3.60,z-.20,.14,.15,5.92,warm);
    block(pit,4,1.87,z-3.06,.16,3.74,.16,dark);
    block(pit,7,.043,z-3.07,7,.01,.085,concrete);
  }
  block(pit,-3,5.68,-12,10.5,2.25,33,glazing);
  for(let i=0;i<12;i++)block(pit,2.30,5.70,-28+i*2.92,.09,2.25,.095,metal);
  block(pit,-2.4,6.89,-12,12.8,.25,34.8,concrete);
  sign(pit,signTexture('APEX','CIRCUIT OPERATIONS',true),3.38,4.42,-13,6.45,1.02,Math.PI/2);
  // Folded eaves channel, downpipes, lintels and jambs frame individual service bays.
  block(pit,4.48,3.91,0,.14,.17,62.2,metal);
  for(const z of [-29.8,-9.4,10.1,29.8]){
    block(pit,4.39,1.86,z,.12,3.7,.12,metal);
    for(const y of [.54,2.55,3.53])block(pit,4.35,y,z,.21,.045,.17,dark);
  }
  for(let i=0;i<9;i++){
    const z=-26+i*6.5;
    for(const side of [-1,1])block(pit,2.89,1.81,z+side*2.83,.21,3.56,.13,dark);
    block(pit,2.89,3.59,z,.20,.13,5.79,metal);
    const bracket=new T.Vector3(4.33,3.75,z);
    strut(pit,new T.Vector3(2.87,3.09,z),bracket,.075,metal);
    if(i===2||i===6){
      block(pit,3.45,.56,z+1.35,.64,.96,1.15,warm);
      block(pit,3.45,1.065,z+1.35,.7,.06,1.21,dark);
      for(let k=0;k<5;k++)block(pit,3.78,.26+.16*k,z+1.35,.035,.025,.96,metal);
    }
  }
  batchParts(pit);

  // Covered stand along the straight, outside the barrier and facing the racing line.
  const stand=new T.Group();stand.position.set(-89,1.6,118);scene.add(stand);
  block(stand,0,-1.86,0,12,3.74,49,concrete);
  for(let row=0;row<7;row++){
    const x=-4.7+row*1.28,h=.38+row*.43;
    block(stand,x,h/2,0,1.38,h,46,concrete);
    for(let bay=0;bay<4;bay++){
      const z=-17.6+bay*11.7;
      block(stand,x,h+.16,z,.6,.18,9.75,row%3?dark:warm);
      block(stand,x+.27,h+.35,z,.10,.32,9.75,row%3?dark:warm);
    }
  }
  for(const z of [-22,-11,0,11,22]){
    const post=new T.Vector3(4.3,7.0,z),tip=new T.Vector3(-6.1,6.35,z);
    strut(stand,new T.Vector3(4.9,0,z),post,.17,metal);
    strut(stand,post,tip,.18,metal);strut(stand,new T.Vector3(4.5,5.1,z),new T.Vector3(-1,6.66,z),.11,metal);
  }
  const roof=block(stand,-.8,6.77,0,11.2,.19,47.6,metal);roof.rotation.z=.062;
  batchParts(stand);

  const tires=new T.InstancedMesh(new T.TorusGeometry(.32,.12,7,16).rotateX(-Math.PI/2),
    new T.MeshStandardMaterial({color:0x292c2c,roughness:.97}),3*30);
  const temp=new T.Object3D();
  // Tire packs behind the Armco on the outside of the tight return.
  const start=stations.findIndex(s=>s.p.z>275 && s.p.x>165);
  for(let i=0;i<30;i++){
    const s=stations[start+Math.floor(i/3)],n=stations[start+Math.floor(i/3)+1];
    const p=s.p.clone().lerp(n.p,(i%3)/3).addScaledVector(s.right,-8.25);
    for(let layer=0;layer<3;layer++){
      temp.position.set(p.x,p.y+.12+layer*.23,p.z);temp.updateMatrix();tires.setMatrixAt(i*3+layer,temp.matrix);
    }
  }
  scene.add(tires);
}
