import * as T from 'three';
import {batchParts} from './batch.ts';
import {checkpointGates,sectorBoundaryIndices} from './lap-timing.ts';
import {wearHalfWidth,type RoadWear} from './road-wear.ts';
import {courseLength,railOffset,roadHalfWidth,roadRipple,sampleAt,type Station} from './track.ts';

type Surface = {positions:number[];uvs:number[];wearUvs:number[];indices:number[]};
const makeSurface = ():Surface => ({positions:[],uvs:[],wearUvs:[],indices:[]});

function addQuad(target:Surface,a:Station,b:Station,left:number,right:number,height:number){
  const start=target.positions.length/3;
  for(const s of [a,b]){
    for(const edge of [left,right]){
      const p=s.p.clone().addScaledVector(s.right,edge);
      p.y+=height+roadRipple(s,edge);
      target.positions.push(p.x,p.y,p.z);
      target.uvs.push(p.x,p.z);
      target.wearUvs.push(s.distance/courseLength,.5+edge/(2*wearHalfWidth));
    }
  }
  target.indices.push(start,start+1,start+2,start+1,start+3,start+2);
}

function buildMesh(source:Surface,material:T.Material,name:string){
  const geo=new T.BufferGeometry();
  geo.setAttribute('position',new T.Float32BufferAttribute(source.positions,3));
  geo.setAttribute('uv',new T.Float32BufferAttribute(source.uvs,2));
  geo.setAttribute('trackWearUv',new T.Float32BufferAttribute(source.wearUvs,2));
  geo.setIndex(source.indices);
  geo.computeVertexNormals();
  const mesh=new T.Mesh(geo,material);
  mesh.name=name;
  mesh.receiveShadow=true;
  return mesh;
}

function sectorPlateMaterial(label:string){
  let map:T.CanvasTexture|undefined;
  if(typeof document!=='undefined'){
    const canvas=document.createElement('canvas');
    canvas.width=256;canvas.height=160;
    const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#ebe9de';ctx.fillRect(0,0,256,160);
    ctx.fillStyle='#c86b3a';ctx.fillRect(0,0,24,160);
    ctx.strokeStyle='#202930';ctx.lineWidth=8;ctx.strokeRect(4,4,248,152);
    ctx.fillStyle='#182026';
    ctx.font='900 106px Arial, sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(label,140,84);
    map=new T.CanvasTexture(canvas);
    map.colorSpace=T.SRGBColorSpace;
    map.anisotropy=8;
  }
  return new T.MeshStandardMaterial(map?{map,color:0xffffff,roughness:.72}:{color:0xebe9de,roughness:.72});
}

// Low-contrast road timing loops and compact rail-side timing posts mark the 19
// intermediate gates checked by LapTiming without altering track physics or cluttering HUD.
// Sector boundary gates (G07 -> S1 end, G14 -> S2 end) carry double inner-edge ticks and
// compact matte S1/S2 plates mounted on the existing timing posts.
export function placeCheckpointMarkers(scene:T.Object3D,wear?:RoadWear){
  const group=new T.Group();
  group.name='Checkpoint markers';
  const markers:Array<{index:number;distance:number;lateralOffset:number;sectorEnd:number|null;position:number[]}>=[];
  group.userData.markers=markers;

  const loopSurface=makeSurface();
  const edgeSurface=makeSurface();
  const innerEdge=roadHalfWidth-.32; // 5.28 m, cleanly inside the white edge line (5.30..5.46 m)
  const postOffset=railOffset+.16; // 7.41 m, behind the guardrail collider and inside the 7.60 m bridge deck

  const postSteel=new T.MeshStandardMaterial({color:0x3b424a,metalness:.58,roughness:.48});
  const housingMat=new T.MeshStandardMaterial({color:0x242a30,metalness:.28,roughness:.62});
  const bandMat=new T.MeshStandardMaterial({color:0xc86b3a,roughness:.78});
  const tickMat=new T.MeshStandardMaterial({color:0xd9d8cc,roughness:.80});
  const sectorPlateMats=sectorBoundaryIndices.map((_,idx)=>sectorPlateMaterial('S'+(idx+1)));

  const postGeo=new T.BoxGeometry(.055,1.18,.055);
  const housingGeo=new T.BoxGeometry(.14,.24,.075);
  const bandGeo=new T.PlaneGeometry(.115,.068);
  const tickGeo=new T.PlaneGeometry(.115,.032);
  const plateBackGeo=new T.BoxGeometry(.48,.30,.028);
  const plateFaceGeo=new T.PlaneGeometry(.45,.27);

  checkpointGates.forEach((gate,i)=>{
    const gateNumber=i+1;
    const boundaryIdx=sectorBoundaryIndices.indexOf(gateNumber as (typeof sectorBoundaryIndices)[number]);
    const sectorEnd=boundaryIdx!==-1?boundaryIdx+1:null;
    const d=gate.distance;
    const loopBack=sampleAt(d-.09),loopFront=sampleAt(d+.09);
    // Nine weathered low-contrast dashes across the asphalt lane.
    for(let k=-4;k<=4;k++){
      const cx=k*1.10;
      addQuad(loopSurface,loopBack,loopFront,cx-.28,cx+.28,.0175);
    }
    // Slightly warmer muted threshold ticks right inside both white edge lines.
    // Sector boundaries use a paired double-tick for subtle visual distinction.
    if(sectorEnd!==null){
      for(const shift of [-.17,.17]){
        const tickBack=sampleAt(d+shift-.08),tickFront=sampleAt(d+shift+.08);
        addQuad(edgeSurface,tickBack,tickFront,-innerEdge,-innerEdge+.46,.018);
        addQuad(edgeSurface,tickBack,tickFront,innerEdge-.46,innerEdge,.018);
      }
    }else{
      const tickBack=sampleAt(d-.12),tickFront=sampleAt(d+.12);
      addQuad(edgeSurface,tickBack,tickFront,-innerEdge,-innerEdge+.42,.018);
      addQuad(edgeSurface,tickBack,tickFront,innerEdge-.42,innerEdge,.018);
    }

    const q=new T.Quaternion().setFromAxisAngle(T.Object3D.DEFAULT_UP,Math.atan2(-gate.forward.x,-gate.forward.z));
    for(const sign of [-1,1]){
      const offset=sign*postOffset;
      const base=gate.p.clone().addScaledVector(gate.right,offset);
      base.y+=roadRipple(gate,offset);
      const part=(geo:T.BufferGeometry,mat:T.Material,y:number,z:number)=>{
        const mesh=new T.Mesh(geo,mat);
        mesh.position.set(0,y,z).applyQuaternion(q).add(base);
        mesh.quaternion.copy(q);
        mesh.castShadow=mesh.receiveShadow=true;
        group.add(mesh);
      };
      part(postGeo,postSteel,.53,0);
      part(housingGeo,housingMat,1.06,.015);
      part(bandGeo,bandMat,1.11,.055);
      part(tickGeo,tickMat,1.035,.055);
      if(boundaryIdx!==-1){
        part(plateBackGeo,housingMat,1.33,.015);
        part(plateFaceGeo,sectorPlateMats[boundaryIdx],1.33,.031);
      }
    }
    markers.push({index:gateNumber,distance:d,lateralOffset:postOffset,sectorEnd,position:gate.p.toArray()});
  });

  batchParts(group);
  postGeo.dispose();housingGeo.dispose();bandGeo.dispose();tickGeo.dispose();
  plateBackGeo.dispose();plateFaceGeo.dispose();

  const loopMat=new T.MeshStandardMaterial({
    color:0x9b9d96,roughness:.90,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,
  });
  const edgeMat=new T.MeshStandardMaterial({
    color:0xc27746,roughness:.87,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,
  });
  wear?.apply(loopMat,.72);
  wear?.apply(edgeMat,.72);

  group.add(buildMesh(loopSurface,loopMat,'Checkpoint timing loops'));
  group.add(buildMesh(edgeSurface,edgeMat,'Checkpoint edge ticks'));
  scene.add(group);
  return group;
}
