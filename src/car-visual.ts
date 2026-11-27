import {PopupHeadlights} from './popup-headlights.ts';
import {fitRearBadge} from './f40-badge.ts';
import {buildWiper} from './wiper.ts';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {upholstery,ribbedLens} from './finishes.ts';
import {Driver} from './driver.ts';
import {Mirrors} from './mirrors.ts';
import {asset} from './environment.ts';
import {buildCabin,type Switch} from './f40-cabin.ts';
import {lightFlags} from '../multiplayer-poc/src/game.ts';
import type {Vehicle} from './vehicle.ts';
export type {Switch};
export class CarVisual {
  readonly group=new T.Group();
  readonly eye=new T.Vector3(-.333,.990,.090);
  readonly hood=new T.Vector3(0,1.232,-.85);
  readonly hitTargets:T.Mesh[]=[];
  readonly wheels:Array<{pivot:T.Group;roller:T.Group}>=[];
  readonly mirrors=new Mirrors();
  readonly driver=new Driver();
  private poseWiper!:(travel:number)=>void;
  steering!:T.Group;
  private cabin!:ReturnType<typeof buildCabin>;
  popups!:PopupHeadlights;
  private readonly signals:T.MeshStandardMaterial[]=[];
  private brake?:T.MeshStandardMaterial;
  private head?:T.MeshStandardMaterial;
  private reverse?:T.MeshStandardMaterial;
  private ray=new T.Raycaster();
  private spec:Vehicle['spec'];
  constructor(spec:Vehicle['spec']){this.spec=spec;this.eye.y-=spec.bodyOrigin;this.hood.y-=spec.bodyOrigin;}
  async load(exteriorOnly=false){
    const {scene:body}=await new GLTFLoader().loadAsync(asset('f40-road.glb'));
    const {spec}=this;body.position.y=-spec.bodyOrigin;this.group.add(body);
    const red=new T.MeshPhysicalMaterial({color:0xc52118,metalness:.035,roughness:.31,clearcoat:.95,clearcoatRoughness:.19,ior:1.49});
    const glass=new T.MeshPhysicalMaterial({color:0xc6d2d3,roughness:.075,metalness:0,ior:1.52,specularIntensity:.9,transparent:true,opacity:.085,depthWrite:false,side:T.DoubleSide,forceSinglePass:true});
    const wheelIds=['FL','FR','RL','RR'];
    const caliper=new T.MeshStandardMaterial({color:0x424344,metalness:.6,roughness:.45});
    for(const [i,w] of spec.wheels.entries()){
      const pivot=new T.Group(),roller=new T.Group();pivot.name='Hub'+wheelIds[i];pivot.position.set(w.x,0,w.z);this.group.add(pivot);pivot.add(roller);
      const fixed=new T.Mesh(new RoundedBoxGeometry(.065,.152,.076,3,.021),caliper);
      fixed.position.set(Math.sign(w.x)*.058,.028,.137);pivot.add(fixed);this.wheels.push({pivot,roller});
    }
    const meshes:T.Mesh[]=[];body.traverse(n=>{if(n instanceof T.Mesh)meshes.push(n);});
    for(const mesh of meshes){
      let m=mesh.material as T.MeshStandardMaterial;
      const wheel=/^(tire|rim|disc)(FL|FR|RL|RR)/.exec(mesh.name);
      // Hidden from the seated eye by the bodywork, retained in exterior views.
      if(wheel||['part1','part5','part6','part22','part26','part40','signalL','signalR'].includes(mesh.name))mesh.layers.set(1);
      if(mesh.name.startsWith('mirror')){if(!exteriorOnly)this.mirrors.attach(mesh);continue;}
      if(wheel){
        const idx=wheelIds.indexOf(wheel[2]),w=spec.wheels[idx];
        mesh.geometry.translate(-w.x,-.330,-w.z);this.wheels[idx].roller.add(mesh);
        if(wheel[1]==='tire'){m.color.set('#242427');m.roughness=.94;m.metalness=.02;}
        if(wheel[1]==='rim'){m.color.set('#b9b9b5');m.roughness=.34;m.metalness=.89;}
        if(wheel[1]==='disc'){m.color.set('#898782');m.roughness=.49;m.metalness=.79;}
      }else if(m.name==='material'){mesh.material=red;}
      else if(m.name.startsWith('F40_Window')||m.name.startsWith('F40_Glass')||m.name==='F40_Headlights'){mesh.material=glass;mesh.renderOrder=2;}
      else if(mesh.name.startsWith('signal')){m=m.clone();mesh.material=m;m.color.set('#bf5620');m.emissive.set('#ff8d16');ribbedLens(m,.749);this.signals[mesh.name==='signalL'?0:1]=m;}
      else if(m.name==='super_brakelight'){this.brake=m;m.color.set('#a82012');m.emissive.set('#fd220c');m.roughness=.28;ribbedLens(m,.576);}
      else if(m.name==='super_headlight'){this.head=m;m.emissive.set('#fff0cb');}
      else if(m.name==='super_reverselight'){this.reverse=m;m.emissive.set('#fff5df');}
      else if(m.name==='F40_Cockpit'){m.color.set('#3d3c3a');m.metalness=0;m.roughness=.88;upholstery(mesh,m,'dash');}
      else if(m.name==='F40_Cockpit_HR'){m.color.set('#8a302b');m.metalness=0;m.roughness=.96;upholstery(mesh,m,'textile');}
      else if(m.name==='F40_Skin'){m.color.set('#912e29');m.roughness=.94;upholstery(mesh,m);}
      else if(m.name==='F40_Carbon'){m.color.set('#313234');m.roughness=.64;upholstery(mesh,m,'composite');}
      else if(m.name.startsWith('F40_Chrome')){m.metalness=.85;m.roughness=.28;}
      mesh.castShadow=mesh.material!==glass;mesh.receiveShadow=true;
    }
    if(this.wheels.some(w=>w.roller.children.length<3)||!this.brake||!this.head)throw Error('Incomplete F40 vehicle asset');
    fitRearBadge(body);
    if(!exteriorOnly){
      this.poseWiper=buildWiper(body);
      this.cabin=buildCabin(body,this.hitTargets);this.steering=this.cabin.steering;
      await this.driver.load(this.steering.parent!);
    }
    this.popups=new PopupHeadlights(body,!exteriorOnly);
  }
  syncExteriorLights(flags:number,dt:number){
    this.popups.requested=Boolean(flags&lightFlags.auxiliary);
    this.popups.step(dt);this.popups.sync(1);
    if(this.head)this.head.emissiveIntensity=flags&lightFlags.lights?.78:.015;
    if(this.brake)this.brake.emissiveIntensity=flags&lightFlags.brake?2.9:flags&lightFlags.lights?.52:.07;
    if(this.reverse)this.reverse.emissiveIntensity=flags&lightFlags.reverse?1.55:0;
    this.signals.forEach((material,i)=>{
      material.emissiveIntensity=flags&(i?lightFlags.right:lightFlags.left)?2.4:.025;
    });
  }
  set instrumentBrightness(value:number){this.cabin.instruments.brightness=value;}
  hit(camera:T.Camera,ndc:T.Vector2){
    this.ray.setFromCamera(ndc,camera);
    return this.ray.intersectObjects(this.hitTargets,false)[0]?.object.userData.action as Switch|undefined;
  }
  sync(car:Vehicle,alpha:number){
    this.group.position.lerpVectors(car.previous.position,car.current.position,alpha);
    this.group.quaternion.slerpQuaternions(car.previous.rotation,car.current.rotation,alpha);
    const [left,right]=car.wheelState;
    const roadAngle=T.MathUtils.lerp(left.previousSteer+right.previousSteer,left.steer+right.steer,alpha)*.5;
    this.steering.rotation.z=roadAngle*car.spec.steering.ratio;
    this.driver.pose(this.steering.rotation.z);
    this.wheels.forEach(({pivot,roller},i)=>{
      const w=car.wheelState[i];pivot.position.y=car.spec.mountHeight-T.MathUtils.lerp(w.previousLength,w.length,alpha);
      pivot.rotation.y=T.MathUtils.lerp(w.previousSteer,w.steer,alpha);
      roller.rotation.x=-T.MathUtils.lerp(w.previousSpin,w.spin,alpha);
    });
    this.cabin.sync(car,this.popups.requested);
    this.popups.sync(alpha);
    this.poseWiper(car.wiper.travel(alpha));
    if(this.head)this.head.emissiveIntensity=car.lights?.78:.015;
    if(this.brake)this.brake.emissiveIntensity=car.brakeLight?2.9:car.lights?.52:.07;
    if(this.reverse)this.reverse.emissiveIntensity=car.gear<0?1.55:0;
    this.signals.forEach((m,i)=>m.emissiveIntensity=car.blink&&(car.turn===2||car.turn===(i?1:-1))?2.4:.025);
  }
}
