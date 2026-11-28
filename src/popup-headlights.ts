import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

const openAngle=.80;
const seconds=.73;
function flutedGlass(){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;
  const ctx=canvas.getContext('2d')!,gradient=ctx.createLinearGradient(0,0,0,256);
  gradient.addColorStop(0,'#cbd1c8');gradient.addColorStop(.35,'#f4edce');gradient.addColorStop(1,'#8d9aa0');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,512,256);
  for(let x=7;x<512;x+=16){
    ctx.fillStyle='#737f82';ctx.fillRect(x,2,2,252);
    ctx.fillStyle='#e4e7d9';ctx.fillRect(x+3,2,3,252);
  }
  for(let y=25;y<250;y+=39){ctx.fillStyle='#9da5a1';ctx.fillRect(0,y,512,2);}
  const t=new T.CanvasTexture(canvas);t.colorSpace=T.SRGBColorSpace;t.anisotropy=4;
  return t;
}

export class PopupHeadlights{
  requested=false;
  private progress=0;
  private previous=0;
  private readonly units:Array<{pivot:T.Group;beam:T.SpotLight|null;bulb:T.MeshStandardMaterial}>=[];
  get extension(){return this.progress;}
  get moving(){return this.progress>0&&this.progress<1;}

  constructor(body:T.Group,projectLight=true){
    const steel=new T.MeshStandardMaterial({color:0x343737,metalness:.73,roughness:.46});
    const recess=new T.MeshStandardMaterial({color:0x222021,roughness:.93});
    const lensMap=flutedGlass();
    const axle=new T.Vector3(1,0,0);
    for(const [side,suffix] of [[-1,'L'],[1,'R']] as const){
      const pivot=new T.Group();
      pivot.name='Popup hinge '+suffix;
      pivot.position.set(side*.701,.656,-1.616);
      body.add(pivot);
      const keeper=new T.Mesh(new T.BoxGeometry(.332,.007,.310),recess);
      keeper.name='Headlamp well '+suffix;
      keeper.position.set(side*.702,.455,-1.744);
      body.add(keeper);
      const shaft=new T.Mesh(new T.CylinderGeometry(.008,.008,.242,12).rotateZ(Math.PI/2),steel);
      shaft.position.set(0,-.017,-.006);
      pivot.add(shaft);
      const holder=new T.Mesh(new T.BoxGeometry(.227,.041,.057),steel);
      holder.position.set(0,-.144,-.137);
      holder.rotation.x=-.69;
      pivot.add(holder);
      const bulb=new T.MeshStandardMaterial({map:lensMap,emissiveMap:lensMap,color:0xc7cbbe,metalness:.22,roughness:.28,emissive:0xffe0a6});
      bulb.userData.remoteLight='popupBulb';
      for(const prefix of ['PopupCover','PopupTrim','PopupLens','PopupInsert']){
        const part=body.getObjectByName(prefix+suffix);
        if(!(part instanceof T.Mesh))throw new Error('Missing F40 headlamp mesh '+prefix+suffix);
        pivot.add(part);
        part.position.sub(pivot.position);
        if(prefix==='PopupInsert'||prefix==='PopupLens')part.visible=false;
      }
      // Fit the optical face horizontal in the working pose; convert the whole
      // assembly to coordinates around the original rear hinge for both states.
      const optics=new T.Group();
      optics.name='Halogen optics '+suffix;
      optics.position.set(side*.701,.714,-1.87).sub(pivot.position).applyAxisAngle(axle,-openAngle);
      optics.rotation.x=-openAngle;
      pivot.add(optics);
      const caseMesh=new T.Mesh(new RoundedBoxGeometry(.249,.115,.054,2,.010),steel);
      caseMesh.castShadow=true;optics.add(caseMesh);
      const face=new T.Mesh(new RoundedBoxGeometry(.226,.094,.012,2,.006),bulb);
      face.position.z=-.032;optics.add(face);
      for(const x of [-.117,.117]){
        const screw=new T.Mesh(new T.CylinderGeometry(.0026,.0026,.0024,8).rotateX(Math.PI/2),recess);
        screw.position.set(x,.039,-.029);optics.add(screw);
      }
      const beam=projectLight?new T.SpotLight(0xffe4bb,0,85,.22,.57,1.32):null;
      if(beam){
        beam.position.set(side*.697,.683,-1.86);
        beam.target.position.set(side*2.1,-.6,-35);
        body.add(beam,beam.target);
      }
      this.units.push({pivot,beam,bulb});
    }
  }

  step(dt:number){
    this.previous=this.progress;
    this.progress=T.MathUtils.clamp(this.progress+(this.requested?1:-1)*dt/seconds,0,1);
  }

  reset(){this.requested=false;this.progress=this.previous=0;}

  sync(alpha:number){
    const fraction=T.MathUtils.lerp(this.previous,this.progress,alpha);
    const angle=openAngle*T.MathUtils.smoothstep(fraction,0,1);
    const light=this.requested?T.MathUtils.smoothstep(fraction,.83,.98):0;
    for(const {pivot,beam,bulb} of this.units){
      pivot.rotation.x=angle;
      bulb.emissiveIntensity=2.7*light;
      if(beam)beam.intensity=290*light;
    }
  }
}
