import {batchFixedTrim,panelHardware,wheelHardware} from './cabin-hardware.ts';
import {fitWheelEmblem} from './apex-emblem.ts';
import {CockpitInstruments} from './cockpit-instruments.ts';
import {upholstery} from './finishes.ts';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {batchParts} from './batch.ts';
import type {Vehicle} from './vehicle.ts';

export type Switch = 'ignition'|'key'|'light'|'left'|'right'|'hazard'|'parking'|'traction'|'shift'|'shift-down'|'shift-up'|'wiper'|'popup'|'transmission'|'assist'|'dial';
const alloy = new T.MeshStandardMaterial({color:0xa2a5a1,metalness:.83,roughness:.37});
const brushed = new T.MeshStandardMaterial({color:0x464a4b,metalness:.77,roughness:.4});
const rubber = new T.MeshStandardMaterial({color:0x202022,roughness:.81});
const dark = new T.MeshStandardMaterial({color:0x232528,metalness:.22,roughness:.66});

function part(parent:T.Object3D,geo:T.BufferGeometry,mat:T.Material,x=0,y=0,z=0){
  const m=new T.Mesh(geo,mat);m.position.set(x,y,z);parent.add(m);return m;
}
function cylinder(r:number,h:number,segments=32){
  return new T.CylinderGeometry(r,r,h,segments).rotateX(Math.PI/2);
}
function rounded(w:number,h:number,d:number,r:number){
  return new RoundedBoxGeometry(w,h,d,2,r);
}
function ink(w:number,h:number,draw:(c:CanvasRenderingContext2D)=>void){
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d')!;draw(ctx);
  const map=new T.CanvasTexture(canvas);map.colorSpace=T.SRGBColorSpace;map.anisotropy=8;
  return new T.MeshBasicMaterial({map,toneMapped:false});
}
function label(text:string){
  return ink(384,128,c=>{c.fillStyle='#272729';c.fillRect(0,0,384,128);c.fillStyle='#f2efe2';c.font='bold 76px Arial';c.textAlign='center';c.textBaseline='middle';c.fillText(text,192,66,355);});
}
function createWheel(parent:T.Group){
  const column=new T.Group();column.position.set(-.333,.620,-.448);column.rotation.x=-.32;parent.add(column);
  part(column,cylinder(.050,.13),rubber,0,0,-.071);
  const wheel=new T.Group();wheel.name='Three-spoke wheel';column.add(wheel);
  const leather=new T.MeshStandardMaterial({color:0x292628,roughness:.62});
  const grip=part(wheel,new T.TorusGeometry(.160,.0175,20,120),leather);
  upholstery(grip,leather);leather.normalScale.setScalar(.42);grip.castShadow=grip.receiveShadow=true;
  const spoke=new T.Shape();spoke.moveTo(-.024,.021);spoke.quadraticCurveTo(-.019,.072,-.014,.139);
  spoke.lineTo(-.024,.160);spoke.lineTo(.024,.160);spoke.lineTo(.014,.139);spoke.quadraticCurveTo(.019,.072,.024,.021);spoke.closePath();
  const hole=new T.Path();hole.absellipse(0,.090,.006,.024,0,Math.PI*2,true,0);spoke.holes.push(hole);
  for(const a of [1.31,-1.31,Math.PI])part(wheel,new T.ExtrudeGeometry(spoke,{depth:.006,bevelEnabled:false}),brushed).rotation.z=a;
  part(wheel,cylinder(.043,.017),rubber,0,0,.007);
  fitWheelEmblem(wheel);
  wheelHardware(wheel);
  batchParts(wheel);return wheel;
}
export function buildCabin(parent:T.Group,hitTargets:T.Mesh[]){
  const steering=createWheel(parent);
  const panel=new T.Group();panel.name='Instrument binnacle';panel.position.set(-.333,.800,-.607);panel.rotation.x=-.18;parent.add(panel);
  // Rolled lip over an extruded trapezoidal instrument hood.
  const hood=new T.Shape();hood.moveTo(-.177,-.067);hood.lineTo(-.171,.057);
  hood.quadraticCurveTo(-.17,.088,-.146,.09);hood.quadraticCurveTo(0,.098,.146,.09);
  hood.quadraticCurveTo(.17,.088,.171,.057);hood.lineTo(.177,-.067);hood.quadraticCurveTo(0,-.082,-.177,-.067);
  const guard=part(panel,new T.ExtrudeGeometry(hood,{depth:.076,bevelEnabled:true,bevelThickness:.004,bevelSize:.004,bevelSegments:3}),dark,0,0,-.090);
  guard.castShadow=true;
  const rim=new T.Shape();
  rim.moveTo(-.174,-.044);rim.lineTo(-.170,.069);rim.quadraticCurveTo(-.169,.091,-.145,.092);
  rim.quadraticCurveTo(0,.103,.145,.092);rim.quadraticCurveTo(.169,.091,.170,.069);rim.lineTo(.174,-.044);
  rim.lineTo(.168,-.044);rim.lineTo(.164,.068);rim.quadraticCurveTo(.163,.085,.145,.086);
  rim.quadraticCurveTo(0,.097,-.145,.086);rim.quadraticCurveTo(-.164,.084,-.164,.068);rim.lineTo(-.168,-.044);rim.closePath();
  part(panel,new T.ExtrudeGeometry(rim,{depth:.066,bevelEnabled:false}),rubber,0,0,-.044);
  const instruments=new CockpitInstruments();
  instruments.add(panel,-.078,0,.071,'km/h',Array.from({length:9},(_,i)=>String(i*40)),v=>v.speed*3.6/320);
  instruments.add(panel,.078,0,.071,'RPM × 1000',Array.from({length:9},(_,i)=>String(i)),v=>v.rpm/8000,.875);
  const aux=new T.Group();aux.position.set(.003,.765,-.594);aux.rotation.set(-.22,-.14,0);parent.add(aux);
  part(aux,rounded(.272,.203,.036,.009),dark,0,-.020,-.022);
  panelHardware(panel,aux,parent);
  const powered=(v:Vehicle)=>v.ignition==='ON'||v.ignition==='START';
  aux.name='Auxiliary instruments';
  instruments.add(aux,-.091,.025,.039,'OIL bar',['0','4','8'],v=>v.oilPressure/8);
  instruments.add(aux,-.007,.025,.039,'OIL °C',['40','90','140'],v=>powered(v)?(v.oilTemp-40)/100:0);
  instruments.add(aux,.077,.025,.039,'H₂O °C',['40','80','120'],v=>powered(v)?(v.waterTemp-40)/80:0);
  instruments.add(aux,-.089,-.047,.027,'FUEL',['0','½','1'],v=>powered(v)?v.fuelLitres/v.spec.fuel.capacityLitres:0);
  const toggles:Array<[Switch,string]>=[['left','◀'],['light','LAMP'],['right','▶'],['hazard','HAZ'],['parking','P'],['traction','TC']];
  const painted=toggles.map(([action,name],i)=>{
    const x=-.040+(i%3)*.061,y=-.036-Math.floor(i/3)*.047;
    const cap=part(aux,rounded(.044,.029,.021,.004),rubber,x,y,.002);cap.userData.action=action;hitTargets.push(cap);
    part(cap,new T.PlaneGeometry(.040,.017),label(name),0,0,.011);
    const led=new T.MeshBasicMaterial({color:0x493d32});part(cap,cylinder(.0028,.002,12),led,.016,.010,.012);return led;
  });
  const stalk=new T.Group();stalk.position.set(-.166,.699,-.523);stalk.rotation.z=-.18;parent.add(stalk);
  part(stalk,rounded(.046,.034,.033,.006),dark);
  const wiperSwitch=new T.Group();stalk.add(wiperSwitch);
  part(wiperSwitch,rounded(.076,.009,.011,.003),brushed,.040,0,.012);
  const grip=part(wiperSwitch,rounded(.061,.025,.027,.006),rubber,.088,0,.012);
  grip.userData.action='wiper';hitTargets.push(grip);
  part(grip,new T.PlaneGeometry(.050,.014),label('WIPER'),0,.001,.0145);
  const switchMount=new T.Group();switchMount.name='Pop-up lamp switch';switchMount.position.set(.084,-.111,.009);aux.add(switchMount);
  part(switchMount,rounded(.056,.031,.018,.004),brushed);
  const rocker=part(switchMount,rounded(.043,.022,.013,.003),rubber,0,0,.011);
  rocker.userData.action='popup';hitTargets.push(rocker);
  part(rocker,new T.PlaneGeometry(.037,.015),label('LIFT'),0,0,.007);

  const modeMount=new T.Group();modeMount.name='Transmission mode switch';modeMount.position.set(.012,-.111,.009);aux.add(modeMount);
  part(modeMount,rounded(.078,.026,.016,.004),brushed);
  const modeRocker=part(modeMount,rounded(.069,.020,.012,.003),rubber,0,0,.010);
  modeRocker.userData.action='transmission';hitTargets.push(modeRocker);
  const autoLabel=label('AUTO'),manualLabel=label('MAN');
  part(modeRocker,new T.PlaneGeometry(.031,.014),autoLabel,-.017,0,.0065);
  part(modeRocker,new T.PlaneGeometry(.030,.014),manualLabel,.017,0,.0065);

  const lamp=new T.MeshBasicMaterial();part(panel,cylinder(.004,.003),lamp,0,.055,.004);
  const lock=new T.Group();lock.name='Ignition lock';lock.position.set(-.548,.702,-.563);lock.rotation.x=-.25;parent.add(lock);
  part(lock,cylinder(.034,.020),dark);part(lock,cylinder(.024,.014),alloy,0,0,.010);
  part(lock,rounded(.0034,.016,.002,.001),rubber,0,0,.018);
  part(lock,new T.PlaneGeometry(.066,.020),label('IGN'),0,.047,.002);
  const key=new T.Group();lock.add(key);key.name='Ignition key';
  const blade=new T.Shape();blade.moveTo(-.005,0);blade.lineTo(.005,0);blade.lineTo(.005,.025);blade.lineTo(.001,.022);blade.lineTo(-.001,.026);blade.lineTo(-.005,.023);blade.closePath();
  part(key,new T.ExtrudeGeometry(blade,{depth:.003,bevelEnabled:false}).rotateX(-Math.PI/2),alloy,0,0,.033);
  const bow=new T.Shape();bow.moveTo(-.016,.005);bow.quadraticCurveTo(-.023,-.025,-.009,-.033);bow.lineTo(.009,-.033);bow.quadraticCurveTo(.023,-.025,.016,.005);bow.closePath();
  const ring=new T.Path();ring.absellipse(0,-.023,.008,.0035,0,Math.PI*2,true,0);bow.holes.push(ring);
  part(key,new T.ExtrudeGeometry(bow,{depth:.009,bevelEnabled:true,bevelSize:.001,bevelThickness:.001,bevelSegments:1}),rubber,0,0,.035);
  const target=part(lock,cylinder(.042,.050),new T.MeshBasicMaterial({visible:false}),0,0,.03);target.userData.action='key';hitTargets.push(target);

  const gate=new T.Group();gate.name='Five-speed gate';gate.position.set(.047,.509,-.381);parent.add(gate);
  const frame=new T.Group();
  gate.add(frame);
  part(frame,rounded(.127,.063,.166,.008),brushed,0,-.042,0);
  part(frame,rounded(.117,.014,.152,.004),dark,0,-.014,0);
  part(frame,new T.BoxGeometry(.095,.001,.119),rubber,0,-.006,0);
  // Cut a continuous H-shaped aperture through the metal plate. Local shape Y maps to -Z.
  const plate=new T.Shape();plate.moveTo(-.052,-.067);plate.lineTo(.052,-.067);plate.lineTo(.052,.067);plate.lineTo(-.052,.067);plate.closePath();
  const slot=new T.Path();const edge=.005,l=.032,h=.052;
  const outline=[[-l-edge,-h],[-l+edge,-h],[-l+edge,-edge],[-edge,-edge],[-edge,-h],[edge,-h],[edge,-edge],[l-edge,-edge],[l-edge,-h],[l+edge,-h],[l+edge,h],[l-edge,h],[l-edge,edge],[edge,edge],[edge,h],[-edge,h],[-edge,edge],[-l+edge,edge],[-l+edge,h],[-l-edge,h]];
  outline.forEach(([x,y],i)=>i?slot.lineTo(x,y):slot.moveTo(x,y));slot.closePath();plate.holes.push(slot);
  const gateSteel=new T.MeshStandardMaterial({color:0xb7b8b2,metalness:.81,roughness:.28,envMapIntensity:1.35});
  gateSteel.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 metalPoint;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nmetalPoint=position;');
    shader.fragmentShader='varying vec3 metalPoint;\n'+shader.fragmentShader.replace('#include <roughnessmap_fragment>',`
      #include <roughnessmap_fragment>
      float brush=metalPoint.x*2650.+sin(metalPoint.z*80.)*.08;
      roughnessFactor+=.075*sin(brush)*(1.-smoothstep(.45,2.3,fwidth(brush)));
    `);
  };
  part(frame,new T.ExtrudeGeometry(plate,{depth:.004,bevelEnabled:true,bevelSize:.00075,bevelThickness:.00065,bevelSegments:2}).rotateX(-Math.PI/2),gateSteel);
  for(const x of [-.046,.046])for(const z of [-.059,.059]){
    part(frame,new T.CylinderGeometry(.0037,.0037,.0016,16),brushed,x,.0052,z);
    part(frame,new T.BoxGeometry(.0048,.0006,.00075),rubber,x,.0062,z).rotation.y=x*14+z*19;
  }
  for(const [i,number] of ['R','2','4','1','3','5'].entries()){
    const stamp=part(gate,new T.PlaneGeometry(.010,.007),label(number),(i%3-1)*.032,.0058,i<3?-.060:.060);
    stamp.rotation.x=-Math.PI/2;
  }
  const lever=new T.Group();lever.name='Gear lever';gate.add(lever);lever.position.y=-.083;
  part(lever,new T.LatheGeometry([[.009,0],[.009,.026],[.007,.032],[.005,.046],[.005,.212],[.007,.218],[.010,.225],[.010,.235]].map(([x,y])=>new T.Vector2(x,y)),24),gateSteel);
  const knob=part(lever,new T.SphereGeometry(.024,32,20).scale(1,.89,1),new T.MeshStandardMaterial({color:0x271e1c,roughness:.42}),0,.240,0);
  knob.name='Shifter ball';knob.userData.action='shift';hitTargets.push(knob);
  let lane=0,row=0,oldGear=0,fromLane=0,fromRow=0;
  const leverUp=new T.Vector3(0,1,0),leverAim=new T.Vector3();
  function sync(car:Vehicle,popupsOpen:boolean){
    rocker.rotation.x=popupsOpen?-.23:.23;
    modeRocker.rotation.y=car.automatic?-.14:.14;
    autoLabel.color.setHex(car.automatic?0xffb767:0xb8b8b8);
    manualLabel.color.setHex(car.automatic?0xb8b8b8:0xffb767);
    wiperSwitch.rotation.z={OFF:0,LOW:.12,HIGH:.23}[car.wiper.mode];
    instruments.sync(car);
    const values=[car.blink&&(car.turn===-1||car.turn===2),car.lights,car.blink&&(car.turn===1||car.turn===2),car.turn===2,car.parkingBrake,car.tractionControl];
    painted.forEach((p,i)=>p.color.setHex(values[i]?0xf6a84c:0x493d32));
    lamp.color.setHex(powered(car)&&car.oilPressure<1?0xff3422:0x4c2926);
    key.visible=car.ignition!=='OUT';key.rotation.z=-({OUT:0,OFF:0,ACC:.49,ON:.95,START:1.45}[car.ignition]);
    if(oldGear!==car.gear){fromLane=lane;fromRow=row;oldGear=car.gear;}
    const g=car.gear,t=car.shiftProgress;
    const targetLane=g===0?0:g<2?-1:g<4?0:1,targetRow=g===0?0:g===-1||g%2===0?-1:1;
    lane=T.MathUtils.lerp(fromLane,targetLane,T.MathUtils.clamp((t-.32)/.36,0,1));
    row=t<.32?fromRow*(1-t/.32):targetRow*T.MathUtils.clamp((t-.68)/.32,0,1);
    lever.quaternion.setFromUnitVectors(leverUp,leverAim.set(lane*.032,.088,row*.048).normalize());
  }
  batchFixedTrim(parent);
  return {steering,sync,instruments,gate};
}
