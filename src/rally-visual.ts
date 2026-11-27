import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {DecalGeometry} from 'three/addons/geometries/DecalGeometry.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {Driver} from './driver.ts';
import {Mirrors} from './mirrors.ts';
import {asset} from './environment.ts';
import {upholstery} from './finishes.ts';
import {bevel,part,rallyMat} from './rally-details.ts';
import {buildRallyTrim,buildRearOptics,carbonUV,finishNose,fitFuelDoor,fitRearBadges,paintBody,rallySurfaces} from './rally-surfaces.ts';
import {rallyWheelSet} from './rally-wheel.ts';
import {buildRallyCabin} from './rally-cabin.ts';
import {rallyControlHints} from './rally-controls.ts';
import {lightFlags} from '../shared/game.ts';
import type {Vehicle} from './vehicle.ts';
import type {Switch} from './f40-cabin.ts';
import type {VehicleVisual} from './vehicle-visual.ts';

function rallyLivery(rearOnLeft:boolean){
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=512;
  const ctx=canvas.getContext('2d')!;
  ctx.save();if(rearOnLeft){ctx.translate(1024,0);ctx.scale(-1,1);}
  ctx.fillStyle='#ac191f';ctx.beginPath();ctx.moveTo(0,365);ctx.lineTo(370,292);
  ctx.lineTo(652,85);ctx.lineTo(1024,85);ctx.lineTo(1024,243);ctx.lineTo(702,290);
  ctx.lineTo(435,452);ctx.lineTo(0,500);ctx.closePath();ctx.fill();
  ctx.fillStyle='#17232e';ctx.beginPath();ctx.moveTo(0,417);ctx.lineTo(490,358);
  ctx.lineTo(732,191);ctx.lineTo(1024,165);ctx.lineTo(1024,276);ctx.lineTo(757,281);
  ctx.lineTo(481,457);ctx.lineTo(0,512);ctx.closePath();ctx.fill();ctx.restore();
  ctx.fillStyle='#e6e4db';ctx.fillRect(362,131,274,217);
  ctx.fillStyle='#131c25';ctx.fillRect(362,131,274,41);
  ctx.fillStyle='#f5e6d9';ctx.font='800 23px system-ui';ctx.fillText('ALPINE RALLY',383,161);
  ctx.fillStyle='#141e28';ctx.font='italic 900 142px system-ui';ctx.fillText('35',396,306);
  ctx.fillStyle='#a92328';ctx.fillRect(362,328,274,20);
  ctx.font='italic 800 35px system-ui';ctx.fillStyle='#192730';ctx.fillText('APEX MOTORSPORT',300,110);
  const map=new T.CanvasTexture(canvas);map.colorSpace=T.SRGBColorSpace;map.anisotropy=8;
  return new T.MeshStandardMaterial({map,transparent:true,alphaTest:.10,roughness:.39,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});
}

class AuxiliaryLamps{
  requested=false;
  private intensity=0;
  constructor(private readonly material:T.MeshStandardMaterial){}
  step(dt:number){this.intensity=T.MathUtils.damp(this.intensity,this.requested?1:0,18,dt);}
  sync(){this.material.emissiveIntensity=.025+this.intensity*2.1;}
  reset(){this.requested=false;this.intensity=0;}
}

// Bake the static model's per-part transforms and submit opaque parts in
// material batches. Separate lenses, reflections and moving parts stay separate.
function batchRallyShell(body:T.Group,root:T.Group){
  const buckets=new Map<string,T.Mesh<T.BufferGeometry,T.Material>[]>();
  body.traverse(node=>{
    if(!(node instanceof T.Mesh)||!node.visible||Array.isArray(node.material)||node.material.transparent)return;
    const attrs=Object.keys(node.geometry.attributes).sort().join('/');
    const key=node.material.uuid+'|'+attrs+'|'+Number(Boolean(node.geometry.index));
    const meshes=buckets.get(key)??[];meshes.push(node);buckets.set(key,meshes);
  });
  for(const meshes of buckets.values()){
    if(meshes.length<2)continue;
    const geometries=meshes.map(mesh=>{
      const source=mesh.geometry,copy=new T.BufferGeometry();
      for(const [name,attr] of Object.entries(source.attributes)){
        const array=new Float32Array(attr.count*attr.itemSize);
        for(let i=0;i<attr.count;i++)for(let component=0;component<attr.itemSize;component++)
          array[i*attr.itemSize+component]=attr.getComponent(i,component);
        copy.setAttribute(name,new T.BufferAttribute(array,attr.itemSize));
      }
      if(source.index)copy.setIndex(source.index.clone());
      return copy.applyMatrix4(mesh.matrixWorld);
    });
    const geometry=mergeGeometries(geometries);
    if(geometry){
      part(root,geometry,meshes[0].material);
      // Hidden originals stay attached for disposal and share source buffers.
      meshes.forEach(mesh=>{mesh.visible=false;});
    }
    geometries.forEach(copy=>copy.dispose());
  }
}

export class RallyVisual implements VehicleVisual {
  readonly group=new T.Group();
  readonly eye:T.Vector3;
  readonly hood:T.Vector3;
  readonly hitTargets:T.Mesh[]=[];
  readonly wheels:Array<{pivot:T.Group;roller:T.Group}>=[];
  readonly mirrors=new Mirrors();
  readonly studioLighting=true;
  readonly driver=new Driver({shoulderX:.196,shoulderY:.045,shoulderZ:.553,upper:.293,forearm:.272,woven:true});
  steering!:T.Group;
  popups!:AuxiliaryLamps;
  private cabin!:ReturnType<typeof buildRallyCabin>;
  private readonly trim=new T.Group();
  private readonly ray=new T.Raycaster();
  private readonly tail=new Set<T.MeshStandardMaterial>();
  private readonly head=new Set<T.MeshStandardMaterial>();
  private readonly brake=new Set<T.MeshStandardMaterial>();
  private signals:T.MeshStandardMaterial[]=[];
  private readonly wipers:T.Group[]=[];

  constructor(private readonly spec:Vehicle['spec']){
    const lift=.074-spec.bodyOrigin;
    this.eye=new T.Vector3(-.373,1.190+lift,.380);
    this.hood=new T.Vector3(0,1.017+lift,-1.02);
    this.trim.position.y=lift;
    this.group.name='Nissan GT-R R35 Rally';
  }

  async load(exteriorOnly=false){
    const {scene:body}=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(asset('r35-rally.glb'));
    body.rotation.y=Math.PI;body.position.y=this.trim.position.y;this.group.add(body,this.trim);
    this.group.updateMatrixWorld(true);
    const {paint,windowGlass,carbon,lens,rearLens}=rallySurfaces();
    const fabric=rallyMat(0x25282a,.91);
    const interiorTuning=new Map<T.MeshStandardMaterial,T.MeshStandardMaterial>();
    const doors:T.Mesh[]=[];
    const mirrors:T.Mesh[]=[];
    const rearHousings:T.Mesh[]=[],headHousings:T.Mesh[]=[],rearPanels:T.Mesh[]=[],paintedPanels:T.Mesh[]=[];
    body.traverse(node=>{
      if(!(node instanceof T.Mesh))return;
      const mat=node.material as T.MeshStandardMaterial, tag=node.name;
      node.castShadow=node.receiveShadow=true;
      if(mat.name==='r35_paint'){
        node.material=paint;paintBody(node);paintedPanels.push(node);
        if(/^r35_(bumper_R|trunk_cf).*paint/.test(tag))rearPanels.push(node);
        if(/^r35_door_R(?:001)?_r35_paint/.test(tag))doors.push(node);
      }
      if(/windshield|doorglass|backlight/.test(tag)&&mat.name.includes('glass')){
        node.material=windowGlass;node.renderOrder=2;node.castShadow=false;
      }
      if(/headlightglass|taillightglass/.test(tag)){
        node.material=tag.includes('taillightglass')?rearLens:lens;
        node.renderOrder=3;node.castShadow=false;
      }
      if(mat.name==='r35_cf'){
        carbonUV(node.geometry,node.matrixWorld);
        node.material=carbon;
      }
      if(/_headlight_[LR]_2012_r35_lights_/.test(tag))headHousings.push(node);
      if(/r35_(intmirror|mirror_[LR]_cf)_mirror/.test(tag))mirrors.push(node);
      if(/_r35_taillight_/.test(tag)){
        const isolated=mat.clone();node.material=isolated;
        isolated.emissive.set(0x9f1007);isolated.roughness=.33;this.tail.add(isolated);rearHousings.push(node);
      }
      if(/_r35_highbeam_/.test(tag)){
        mat.emissive.set(0xe4efff);this.head.add(mat);
      }
      // The source bumper signal material covers the entire lower trim.
      // Only the four factory lamp housings and dedicated LED guides emit brake light.
      if(/_seat_F.*leather_(?:perf_)?0$/.test(tag)){
        node.material=fabric;upholstery(node,fabric,'textile');
      }
      if(/r35_dash_|r35_doorpanel_|r35_signalstalk_/.test(tag)&&['r35_plastic','r35_interior'].includes(mat.name)){
        let surface=interiorTuning.get(mat);
        if(!surface){
          surface=mat.clone();
          surface.roughness=mat.name==='r35_plastic'?.58:.49;
          surface.metalness=mat.name==='r35_plastic'?0:.21;
          surface.normalScale.multiplyScalar(.72);
          interiorTuning.set(mat,surface);
        }
        node.material=surface;
      }
      if(/r35_exhaust_LW/.test(tag))node.visible=false;
      if(/^r35_gauges_.*display_segment_|^r35_speedunit_/.test(tag))node.visible=false;
    });
    for(const door of doors){
      const bounds=new T.Box3().setFromObject(door,true),side=Math.sign(bounds.getCenter(new T.Vector3()).x);
      const projection=new T.Vector3(side*.885,.58+this.trim.position.y,.013);
      const orient=new T.Euler(0,side*Math.PI/2,0), dimensions=new T.Vector3(1.48,.72,.38);
      const decal=part(this.group,new DecalGeometry(door,projection,orient,dimensions),rallyLivery(side<0));
      decal.castShadow=false;decal.renderOrder=1;
    }
    for(const original of exteriorOnly?[]:mirrors){
      const material=original.material as T.Material;
      const mesh=original.clone();
      const geometry=mesh.geometry.clone(),positions=geometry.getAttribute('position');
      const xyz=new Float32Array(positions.count*3);
      for(let i=0;i<positions.count;i++){xyz[i*3]=positions.getX(i);xyz[i*3+1]=positions.getY(i);xyz[i*3+2]=positions.getZ(i);}
      geometry.setAttribute('position',new T.BufferAttribute(xyz,3));
      mesh.geometry=geometry.applyMatrix4(original.matrixWorld);
      mesh.position.set(0,0,0);mesh.quaternion.identity();mesh.scale.setScalar(1);
      mesh.name=original.name.includes('_L_')?'mirrorLeft':original.name.includes('_R_')?'mirrorRight':'mirrorCenter';
      this.group.add(mesh);original.visible=false;mesh.material=material;this.mirrors.attach(mesh);
    }
    const optics=buildRearOptics(this.group,rearHousings);
    this.tail.add(optics.running);this.brake.add(optics.brake);
    const nose=finishNose(this.trim,headHousings,lens);
    // The lamp survey is at simulation-body height, while the auxiliary kit uses stock trim height.
    const factoryGuides=this.trim.getObjectByName('R35 headlamp guides')!;
    this.group.add(factoryGuides);
    this.head.add(nose.LED);
    fitRearBadges(this.group,rearPanels);
    fitFuelDoor(this.group,paintedPanels);
    if(!exteriorOnly)this.cabin=buildRallyCabin(this.trim,body,this.hitTargets);
    batchRallyShell(body,this.group);
    const hubNames=['HubFL','HubFR','HubRL','HubRR'];
    const buildWheel=rallyWheelSet(this.spec.radius);
    this.spec.wheels.forEach((wheel,i)=>{
      const pivot=new T.Group(),roller=new T.Group();pivot.name=hubNames[i];pivot.position.set(wheel.x,0,wheel.z);
      this.group.add(pivot);pivot.add(roller);this.wheels.push({pivot,roller});
      buildWheel(pivot,roller,Math.sign(wheel.x),i<2);
      pivot.traverse(object=>{if(!object.userData.shadowOnly)object.layers.set(1);});
    });
    const lamps=buildRallyTrim(this.trim,carbon);
    this.popups=new AuxiliaryLamps(nose.core);this.signals=lamps.signals;
    if(!exteriorOnly){
      this.steering=this.cabin.steering;
      await this.driver.load(this.cabin.column);
      this.buildWipers();
    }
    if(doors.length!==2||mirrors.length!==3||!this.head.size||!this.tail.size)throw Error('Incomplete R35 vehicle model');
  }

  syncExteriorLights(flags:number,dt:number){
    this.popups.requested=Boolean(flags&lightFlags.auxiliary);
    this.popups.step(dt);this.popups.sync();
    for(const mat of this.head)mat.emissiveIntensity=flags&lightFlags.lights?1.25:.04;
    for(const mat of this.tail)mat.emissiveIntensity=flags&lightFlags.brake?2.45:flags&lightFlags.lights?.64:.16;
    for(const mat of this.brake)mat.emissiveIntensity=flags&lightFlags.brake?1.55:.025;
    this.signals.forEach((mat,i)=>{mat.emissiveIntensity=flags&(i?lightFlags.right:lightFlags.left)?1.8:.045;});
  }

  private buildWipers(){
    const rubber=rallyMat(0x161719,.84);
    for(const [x,length] of [[-.416,.524],[.186,.432]]){
      const pivot=new T.Group();pivot.position.set(x,.990,-.795);pivot.rotation.x=Math.atan2(-.92,.394);
      this.trim.add(pivot);
      const arm=new T.Group();pivot.add(arm);this.wipers.push(arm);
      part(arm,bevel(length,.015,.011,.004),rubber,length*.5,0,.005);
      part(arm,bevel(.311,.020,.012,.004),rubber,length-.044,0,.012).rotation.z=.10;
    }
  }

  hit(camera:T.Camera,ndc:T.Vector2){
    this.ray.setFromCamera(ndc,camera);
    return this.ray.intersectObjects(this.hitTargets,false)[0]?.object.userData.action as Switch|undefined;
  }
  controlHint(action:Switch){return rallyControlHints[action];}
  animateControl(action:Switch){this.cabin.trigger(action);}
  set instrumentBrightness(value:number){this.cabin.display.brightness=value;}
  sync(car:Vehicle,alpha:number){
    this.group.position.lerpVectors(car.previous.position,car.current.position,alpha);
    this.group.quaternion.slerpQuaternions(car.previous.rotation,car.current.rotation,alpha);
    const [left,right]=car.wheelState;
    this.steering.rotation.z=T.MathUtils.lerp(left.previousSteer+right.previousSteer,left.steer+right.steer,alpha)*.5*car.spec.steering.ratio;
    this.wheels.forEach(({pivot,roller},i)=>{
      const wheel=car.wheelState[i];pivot.position.y=car.spec.mountHeight-T.MathUtils.lerp(wheel.previousLength,wheel.length,alpha);
      pivot.rotation.y=T.MathUtils.lerp(wheel.previousSteer,wheel.steer,alpha);
      roller.rotation.x=-T.MathUtils.lerp(wheel.previousSpin,wheel.spin,alpha);
    });
    const paddle=this.cabin.sync(car,this.popups.requested);
    this.driver.pose(this.steering.rotation.z,paddle.side,paddle.pull);
    this.popups.sync();
    this.wipers.forEach((arm,i)=>{arm.rotation.z=(i===0?.08:.13)+car.wiper.travel(alpha)*(i===0?1.36:1.14);});
    for(const mat of this.head)mat.emissiveIntensity=car.lights?1.25:.04;
    for(const mat of this.tail)mat.emissiveIntensity=car.brakeLight?2.45:car.lights?.64:.16;
    for(const mat of this.brake)mat.emissiveIntensity=car.brakeLight?1.55:.025;
    this.signals.forEach((mat,i)=>{mat.emissiveIntensity=car.blink&&(car.turn===2||car.turn===(i?1:-1))?1.8:.045;});
  }
}
