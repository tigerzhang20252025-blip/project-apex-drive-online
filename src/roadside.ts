import * as T from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {onBridge,stations,terrainY,railOffset,roadRipple,type Station} from './track.ts';

export function embankmentWidth(s:Station){
  return 3.2+Math.max(0,s.p.y-terrainY(s.p.x,s.p.z))*.95;
}
export function bridgeStructure(scene:T.Object3D,world:RAPIER.World){
  const concrete=new T.MeshStandardMaterial({color:0xa9a597,roughness:.92});
  const girders=new T.MeshStandardMaterial({color:0x566361,metalness:.48,roughness:.61});
  const deckPanels: T.Matrix4[]=[],beams:T.Matrix4[]=[],piers:T.Matrix4[]=[];
  function box(batch:T.Matrix4[],at:T.Vector3,size:T.Vector3,q:T.Quaternion){
    batch.push(new T.Matrix4().compose(at,q,size));
    world.createCollider(RAPIER.ColliderDesc.cuboid(size.x/2,size.y/2,size.z/2).setTranslation(at.x,at.y,at.z).setRotation(q).setFriction(.65));
  }
  const up=new T.Vector3(0,1,0),unit=new T.Quaternion();
  for(let i=1;i<stations.length;i++){
    const a=stations[i-1],b=stations[i];if(!onBridge(a))continue;
    const z=b.p.clone().sub(a.p),len=z.length();z.normalize();
    const x=new T.Vector3(-z.z,0,z.x);x.y=a.right.y;x.normalize().negate();
    const y=new T.Vector3().crossVectors(z,x).normalize();x.crossVectors(y,z).normalize();
    const q=new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z));
    const p=a.p.clone().lerp(b.p,.5);
    box(deckPanels,p.clone().addScaledVector(y,-.42),new T.Vector3(15.2,.58,len+.12),q);
    for(const side of [-1,1])box(beams,p.clone().addScaledVector(x,side*5.5).addScaledVector(y,-1.03),new T.Vector3(.35,.92,len+.14),q);
    if(i%10===0){
      const ground=terrainY(p.x,p.z)-.45,top=p.y-1.48,h=top-ground;
      if(h>0){
        for(const side of [-1,1])box(piers,new T.Vector3(p.x+x.x*side*4,ground+h/2,p.z+x.z*side*4),new T.Vector3(1.3,h,1.3),unit);
        const yaw=new T.Quaternion().setFromAxisAngle(up,Math.atan2(z.x,z.z));
        box(piers,p.clone().addScaledVector(up,-1.45),new T.Vector3(12.5,.80,1.5),yaw);
      }
    }
  }
  for(const [arr,mat] of [[deckPanels,concrete],[beams,girders],[piers,concrete]] as const){
    const mesh=new T.InstancedMesh(new T.BoxGeometry(),mat,arr.length);arr.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.castShadow=mesh.receiveShadow=true;scene.add(mesh);
  }
}

// Blades and stone patches are grouped by sector so invisible banks can be culled together.
export function roadsidePlanting(scene:T.Object3D,random:()=>number,rockMap:T.Texture,rockNormal:T.Texture,groundY:(x:number,z:number)=>number){
  const vertices:number[]=[],colours:number[]=[];
  for(let j=0;j<25;j++){
    const az=random()*Math.PI*2,r=Math.sqrt(random())*.20,x=r*Math.cos(az),z=r*Math.sin(az);
    const h=.075+random()*.20,yaw=random()*Math.PI*2,width=.003+random()*.006;
    const dx=width*Math.cos(yaw),dz=width*Math.sin(yaw),bend=.025+.045*random();
    const bx=Math.sin(az)*bend,bz=Math.cos(az)*bend;
    const a=[x-dx,0,z-dz],b=[x+dx,0,z+dz],mid1=[x+bx-dx*.65,h*.53,z+bz-dz*.65],mid2=[x+bx+dx*.65,h*.53,z+bz+dz*.65],tip=[x+bx*2.6,h,z+bz*2.6];
    const shade=.63+random()*.35;
    for(const pt of [a,b,mid1,b,mid2,mid1,mid1,mid2,tip]){
      vertices.push(...pt);const t=pt[1]/h;
      colours.push((.038+t*.14)*shade,(.064+t*.16)*shade,(.012+t*.035)*shade);
    }
  }
  const grass=new T.BufferGeometry();grass.setAttribute('position',new T.Float32BufferAttribute(vertices,3));grass.setAttribute('color',new T.Float32BufferAttribute(colours,3));grass.computeVertexNormals();
  const blades=new T.MeshStandardMaterial({vertexColors:true,side:T.DoubleSide,roughness:1,envMapIntensity:.58});
  const rock=new T.IcosahedronGeometry(1,2),verts=rock.getAttribute('position');
  for(let i=0;i<verts.count;i++){
    const x=verts.getX(i),y=verts.getY(i),z=verts.getZ(i),rad=.89+.12*Math.sin(4*x+3*y)*Math.cos(z*5)+.043*Math.cos(9*y-3*z);
    verts.setXYZ(i,x*rad,y*rad,z*rad);
  }
  rock.computeVertexNormals();
  const stone=new T.MeshStandardMaterial({color:0xb9b9b0,map:rockMap,normalMap:rockNormal,normalScale:new T.Vector2(.8,.8),roughness:.94});
  // Low alpine brush: forked woody stems and folded leaf rosettes in one coloured mesh.
  const shrubPos:number[]=[],shrubColor:number[]=[];
  const tri=(a:T.Vector3,b:T.Vector3,c:T.Vector3,shade:number[])=>{
    shrubPos.push(...a.toArray(),...b.toArray(),...c.toArray());for(let t=0;t<3;t++)shrubColor.push(...shade);
  };
  for(let k=0;k<14;k++){
    const a=k*2.399,h=.26+random()*.43,root=new T.Vector3(0,0,0),tip=new T.Vector3(Math.cos(a)*h*.78,h,Math.sin(a)*h*.78);
    const shaft=new T.CylinderGeometry(.004,.012,tip.length(),4,1,true).toNonIndexed();
    shaft.applyQuaternion(new T.Quaternion().setFromUnitVectors(T.Object3D.DEFAULT_UP,tip.clone().normalize()));shaft.translate(tip.x/2,tip.y/2,tip.z/2);
    shrubPos.push(...shaft.attributes.position.array);for(let j=0;j<shaft.attributes.position.count;j++)shrubColor.push(.11,.084,.047);shaft.dispose();
    for(let j=0;j<9;j++){
      const start=root.clone().lerp(tip,.27+j*.078),yaw=a+j*2.5;
      const end=start.clone().add(new T.Vector3(Math.cos(yaw)*.17,.09,Math.sin(yaw)*.17));
      const m=start.clone().lerp(end,.54),v=new T.Vector3(-Math.sin(yaw)*.043,.016,Math.cos(yaw)*.043),ridge=m.clone();ridge.y+=.018;
      const l=m.clone().sub(v),r=m.clone().add(v),shade=[.074+random()*.045,.135+random()*.067,.045];
      tri(start,l,ridge,shade);tri(l,end,ridge,shade);tri(start,ridge,r,shade);tri(ridge,end,r,shade);
    }
  }
  const shrub=new T.BufferGeometry();shrub.setAttribute('position',new T.Float32BufferAttribute(shrubPos,3));shrub.setAttribute('color',new T.Float32BufferAttribute(shrubColor,3));shrub.computeVertexNormals();
  const cells:T.InstancedMesh[]=[];
  const dummy=new T.Object3D();
  for(let first=0;first<stations.length-1;first+=75){
    const grassInstances:T.Matrix4[]=[],stoneInstances:T.Matrix4[]=[],bushes:T.Matrix4[]=[];
    for(let i=first;i<Math.min(first+75,stations.length-1);i++){
      const s=stations[i];if(onBridge(s))continue;
      for(const sign of [-1,1]){
        const width=embankmentWidth(s),outside=railOffset+.28+.64;
        const density=.45+.35*Math.sin(s.distance*.052+sign)+.17*Math.cos(s.distance*.18);
        if(random()>density)continue;
        const patch=.25+random()**1.6*16;
        for(let j=0;j<12;j++){
          const offset=outside+patch+random()*2.3;
          const p=s.p.clone().addScaledVector(s.right,offset*sign).addScaledVector(s.forward,(random()-.5)*2.6);
          if(p.x< -117&&p.x> -151&&p.z>157&&p.z<245||p.x>-100&&p.x< -81&&p.z>89&&p.z<146)continue;
          const ground=groundY(p.x,p.z);
          if(offset<outside+width){
            const e=s.p.clone().addScaledVector(s.right,sign*(outside+width));
            const edge=s.p.y+s.right.y*sign*outside+roadRipple(s,sign*outside);
            p.y=Math.max(ground, T.MathUtils.lerp(edge,terrainY(e.x,e.z)-.18,(offset-outside)/width));
          }else p.y=ground;
          dummy.position.copy(p);dummy.rotation.set(0,random()*6.28,0);
          if(j===2&&patch>4&&density>.51&&random()<.70){
            const size=.65+random()*1.25;dummy.scale.setScalar(size);dummy.updateMatrix();bushes.push(dummy.matrix.clone());
          }else if(j===0&&random()<.40){
            const size=.12+random()*.78;dummy.scale.set(size*1.5,size*.65,size);dummy.updateMatrix();stoneInstances.push(dummy.matrix.clone());
          }else{
            const h=(offset-outside<3?.45:1)*(.65+random()*.80);
            dummy.scale.set(h*1.5,h,h*1.5);dummy.updateMatrix();grassInstances.push(dummy.matrix.clone());
          }
        }
      }
    }
    for(const [arr,geo,mat] of [[grassInstances,grass,blades],[stoneInstances,rock,stone],[bushes,shrub,blades]] as const){
      if(!arr.length)continue;
      const mesh=new T.InstancedMesh(geo,mat,arr.length);arr.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.receiveShadow=true;mesh.castShadow=geo===rock;mesh.computeBoundingSphere();cells.push(mesh);scene.add(mesh);
    }
  }
  return cells;
}
