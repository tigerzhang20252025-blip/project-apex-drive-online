import * as T from 'three';
import {makeAsphalt} from './asphalt.ts';
import {wearHalfWidth,type RoadWear} from './road-wear.ts';
import {addSponsorBoards} from './sponsor-boards.ts';
import {placeCheckpointMarkers} from './checkpoint-markers.ts';
import {placeTurnSigns} from './turn-signs.ts';
import {plantForest} from './forest.ts';
import {alpineGround} from './alpine-ground.ts';
import { buildPaddock } from './circuit-buildings.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import {bridgeStructure,embankmentWidth,roadsidePlanting} from "./roadside.ts";
import { sampleAt, lineDistance, surveyMeters, roadRipple, onBridge, courseLength, nearestStation, railOffset, roadHalfWidth, stations, terrainY, type Station } from './track.ts';

export const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`;
const roadHeight = .012;
const roadEdge = roadHalfWidth;
const outside = railOffset + .28;

type Surface = { positions: number[]; uvs: number[]; wearUvs:number[]; indices: number[] };
const surface = (): Surface => ({ positions: [], uvs: [], wearUvs:[], indices: [] });
const side = (s: Station, distance: number, h = 0) => s.p.clone().addScaledVector(s.right, distance).add(new T.Vector3(0, h+roadRipple(s,distance), 0));

function strip(target: Surface, samples: Station[], left: number, right: number, height: number,
               slope: 'left' | 'right' | null = null, uvSize = 2.1) {
  const start = target.positions.length / 3;
  samples.forEach((s, i) => {
    const a = side(s, left, height);
    const b = side(s, right, height);
    if (slope) {
      const outer = slope === 'left' ? a : b;
      const width = embankmentWidth(s);
      outer.addScaledVector(s.right, (slope === 'left' ? -1 : 1) * width);
      outer.y = terrainY(outer.x, outer.z) - .18;
    }
    for (const [edge,p] of [[left,a],[right,b]] as const) {
      target.positions.push(p.x, p.y, p.z);
      target.uvs.push(p.x / uvSize, p.z / uvSize);
      target.wearUvs.push(s.distance/courseLength,.5+edge/(2*wearHalfWidth));
    }
    if (i > 0 && !(slope && onBridge(samples[i-1]))) {
      const j = start + (i - 1) * 2;
      target.indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
    }
  });
}

function makeGeometry(source: Surface) {
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(source.positions, 3));
  geo.setAttribute('uv', new T.Float32BufferAttribute(source.uvs, 2));
  if(source.wearUvs.length===source.positions.length/3*2)geo.setAttribute('trackWearUv',new T.Float32BufferAttribute(source.wearUvs,2));
  geo.setIndex(source.indices);
  geo.computeVertexNormals();
  return geo;
}

function addSurface(scene: T.Object3D, world: RAPIER.World, source: Surface, material: T.Material, grip?: number) {
  const mesh = new T.Mesh(makeGeometry(source), material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  if (grip !== undefined) world.createCollider(RAPIER.ColliderDesc.trimesh(
    new Float32Array(source.positions), new Uint32Array(source.indices)).setFriction(grip));
  return mesh;
}

export function loadMap(loader: T.TextureLoader, path: string, srgb: boolean, anisotropy: number) {
  const texture = loader.load(asset(path), undefined, undefined, (error) => console.warn('Texture unavailable', path, error));
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.anisotropy = anisotropy;
  if (srgb) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

const temp = new T.Object3D();
function setInstance(mesh: T.InstancedMesh, index: number, pos: T.Vector3, scale: T.Vector3,
                     rotation = new T.Quaternion(), color?: T.Color) {
  temp.position.copy(pos);
  temp.scale.copy(scale);
  temp.quaternion.copy(rotation);
  temp.updateMatrix();
  mesh.setMatrixAt(index, temp.matrix);
  if (color) mesh.setColorAt(index, color);
}

export function signTexture(text: string, caption: string, dark = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = dark ? '#171d23' : '#eceef0';
  ctx.fillRect(0, 0, 512, 192);
  ctx.fillStyle = '#ff7433';
  ctx.fillRect(0, 0, 16, 192);
  ctx.fillStyle = dark ? '#f6f5f2' : '#17191d';
  ctx.font = 'bold 70px Arial';
  ctx.fillText(text, 36, 93, 450);
  ctx.font = 'bold 25px Arial';
  ctx.fillText(caption, 39, 145, 430);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function fixedBox(scene: T.Object3D, position: T.Vector3, size: T.Vector3, mat: T.Material, rotation = 0) {
  const mesh = new T.Mesh(new T.BoxGeometry(size.x, size.y, size.z), mat);
  mesh.position.copy(position);
  mesh.rotation.y = rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

export function rng(seed: number) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export async function buildEnvironment(scene: T.Object3D, world: RAPIER.World, renderer: T.WebGLRenderer, panorama:Promise<T.Texture>,wear:RoadWear, textures?:Set<T.Texture>) {
  const loader = new T.TextureLoader();
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const load=(path:string,srgb:boolean)=>{
    const texture=loadMap(loader,path,srgb,aniso);
    textures?.add(texture);
    return texture;
  };
  const asphalt = load('asphalt.jpg', true);
  const normals = load('asphalt-normal.jpg', false);
  const alpine=alpineGround(load,panorama);
  const asphaltMaterial=makeAsphalt(asphalt,normals,load('asphalt-rough.jpg',false));
  wear.apply(asphaltMaterial,.46);
  const {terrain:terrainMaterial,verge:vergeMaterial,shoulder:shoulderMaterial}=alpine;
  const paintMaterial = new T.MeshStandardMaterial({ color: 0xe9e8d8, roughness: .83 });
  const pitMaterial=new T.MeshStandardMaterial({color:0xcfaa32,roughness:.81});
  wear.apply(paintMaterial,.72);
  wear.apply(pitMaterial,.72);
  const curbRed = new T.MeshStandardMaterial({ color: 0x9e2e21, roughness: .87 });
  const curbWhite = new T.MeshStandardMaterial({ color: 0xd4d3c6, roughness: .87 });

  const road = surface(), shoulder = surface(), verge = surface(), paint = surface();
  const roadColors:number[]=[];
  for(let band=0;band<16;band++){
    const a=-roadEdge+band*roadEdge/8,b=a+roadEdge/8;
    strip(road,stations,a,b,roadHeight,null,3.4);
    stations.forEach((station,i)=>{
      const other=stations[(i+9)%(stations.length-1)].forward;
      const bend=station.right.dot(other);
      const line=1.55*Math.sin(2.8*bend)+.52*Math.sin(station.distance*.027);
      for(const x of [a,b]){
        const worn=Math.exp(-((x-line)**2)/4.6);
        // Stronger deposits on approach to bends; preserve clean asphalt off the racing line.
        const ahead=stations[(i+24)%(stations.length-1)];
        const braking=T.MathUtils.smoothstep(Math.abs(ahead.curvature)-Math.abs(station.curvature)*.4,.003,.026);
        const track=Math.exp(-((Math.abs(x-line)-.82)**2)/.19);
        const rubber=.99-(.15+.13*braking)*worn-(.045+.16*braking)*track;
        roadColors.push(rubber,rubber,rubber*.995);
      }
    });
  }
  strip(shoulder, stations, -outside, -roadEdge, roadHeight);
  strip(shoulder, stations, roadEdge, outside, roadHeight);
  strip(verge, stations, -outside-.64, -outside-.64, roadHeight, 'left', 2.8);
  strip(verge, stations, outside+.64, outside+.64, roadHeight, 'right', 2.8);
  strip(paint, stations, -roadEdge + .14, -roadEdge + .30, .017);
  strip(paint, stations, roadEdge - .30, roadEdge - .14, .017);
  // Staggered grid boxes mark the start straight. The racing surface stays clear between turns.
  for(let slot=0;slot<10;slot++){
    const d=lineDistance-104+slot*8, x=slot%2?2.55:-2.55;
    strip(paint,[sampleAt(d),sampleAt(d+.12)],x-1.18,x+1.18,.018);
    for(const k of [-1,1]) strip(paint,[sampleAt(d),sampleAt(d+1.15)],x+k*1.18-.057,x+k*1.18+.057,.018);
  }
  const pitLine=surface();
  strip(pitLine,stations.filter(s=>s.distance>=45&&s.distance<=255),-4.08,-3.96,.019);
  addSurface(scene,world,pitLine,pitMaterial,.78);
  for(let i=0;i<12;i++)for(let j=0;j<2;j++){
    if((i+j)%2)continue;
    const d=lineDistance-(j+1)*.54,x=-roadHalfWidth+i*.93;
    strip(paint,[sampleAt(d),sampleAt(d+.54)],x,x+.93,.022);
  }
  const asphaltMesh=addSurface(scene,world,road,asphaltMaterial,.95);
  asphaltMaterial.vertexColors=true;
  asphaltMesh.geometry.setAttribute('color',new T.Float32BufferAttribute(roadColors,3));
  addSurface(scene, world, shoulder, shoulderMaterial, .72);
  addSurface(scene, world, verge, vergeMaterial, .45);
  addSurface(scene, world, paint, paintMaterial, .78);

  const channel=surface(),repairs=surface();
  for(let i=0;i<stations.length-1;i++){
    const a=stations[i],b=stations[i+1];if(onBridge(a))continue;
    for(const sign of [-1,1]){
      const cross=[0,.19,.42,.64],depth=[.012,-.10,-.10,.012];
      for(let j=0;j<3;j++){
        const head=channel.positions.length/3;
        for(const station of [a,b])for(const col of (sign<0?[j+1,j]:[j,j+1])){
          const p=side(station,sign*(outside+cross[col]),depth[col]);channel.positions.push(p.x,p.y,p.z);channel.uvs.push(p.x,p.z);
        }
        channel.indices.push(head,head+1,head+2,head+1,head+3,head+2);
      }
    }
    if(i%73===17){
      const head=repairs.positions.length/3;
      for(let j=0;j<8;j++){
        const x=-3.3+j*.75,step=.18*j+.12*Math.sin(j*1.7+i);
        for(const k of [0,.028]){const p=side(sampleAt(a.distance+step+k),x,roadHeight+.004);repairs.positions.push(p.x,p.y,p.z);repairs.uvs.push(x,step);}
        if(j){const n=head+2*(j-1);repairs.indices.push(n,n+2,n+1,n+1,n+2,n+3);}
      }
    }
  }
  addSurface(scene,world,channel,new T.MeshStandardMaterial({color:0x918e7c,map:asphalt,normalMap:normals,roughness:.96}),.70);
  addSurface(scene,world,repairs,new T.MeshStandardMaterial({color:0x3b3a36,roughness:.81,side:T.DoubleSide}));
  const red = surface(), white = surface();
  const curbSections = [
    ...stations.flatMap((s,i)=>{
      if(i%10!==0||Math.abs(s.curvature)<.006||i+10>=stations.length||onBridge(s))return [];
      const start=s.distance/courseLength,end=stations[i+10].distance/courseLength;
      const inside=Math.sign(s.curvature);
      return [{start,end,sign:inside},...(Math.abs(s.curvature)>.012?[{start,end,sign:-inside}]:[])];
    }),
  ];
  for (const { start, end, sign } of curbSections) {
    for (let d = start * courseLength, i = 0; d + 2.65 < end * courseLength; d += 2.65, i++) {
      const at = [sampleAt(d), sampleAt(d + 1.325), sampleAt(d + 2.65)];
      const target=i%2?red:white;
      // A low trapezoidal kerb. The same triangles feed rendering and Rapier.
      const offsets=[0,.14,.48,.66], heights=[roadHeight+.001,.058,.077,roadHeight+.001];
      for(let k=0;k<3;k++){
        const first=sign>0?k:k+1,second=sign>0?k+1:k,start=target.positions.length/3;
        at.forEach((station,j)=>{
          for(const edge of [first,second]){
            const p=side(station,sign*(roadEdge+offsets[edge]),heights[edge]);
            target.positions.push(p.x,p.y,p.z);target.uvs.push(p.x,p.z);
            target.wearUvs.push(station.distance/courseLength,.5+sign*(roadEdge+offsets[edge])/(2*wearHalfWidth));
          }
          if(j){const a=start+(j-1)*2;target.indices.push(a,a+1,a+2,a+1,a+3,a+2)}
        });
      }
    }
  }
  wear.apply(curbRed,.58);wear.apply(curbWhite,.68);
  addSurface(scene, world, red, curbRed, .83);
  addSurface(scene, world, white, curbWhite, .83);

  const ground = new T.PlaneGeometry(2000, 1990, 250, 248).rotateX(-Math.PI / 2).translate(-12, 0, -105);
  const positions = ground.attributes.position;
  const uv = ground.attributes.uv;
  const colors = [];
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i);
    positions.setY(i, terrainY(x, z));
    uv.setXY(i, x / 2.8, z / 2.8);
    const shade = .84 + .09 * Math.sin(x * .07 + z * .035) + .07 * Math.cos(z * .114 - x * .015);
    colors.push(shade, shade, shade * .95);
  }
  ground.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
  ground.computeVertexNormals();
  const terrain = new T.Mesh(ground, terrainMaterial);
  terrain.receiveShadow = true;
  scene.add(terrain);
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions.array), new Uint32Array(ground.index!.array))
    .setFriction(.45));

  const steel = new T.MeshStandardMaterial({ color: 0x818991, metalness: .55, roughness: .48 });
  const postsMaterial = new T.MeshStandardMaterial({ color: 0x585d57, metalness: .35, roughness: .65 });
  const corrugation=new T.Shape();
  const profile=[[-.40,-.50],[-.40,-.39],[.32,-.25],[.32,-.16],[-.19,-.05],[-.19,.05],[.32,.16],[.32,.25],[-.40,.39],[-.40,.5]];
  profile.forEach(([x,y],i)=>i?corrugation.lineTo(x,y):corrugation.moveTo(x,y));
  for(const [x,y] of [...profile].reverse())corrugation.lineTo(x-.10,y);
  corrugation.closePath();
  const beam=new T.ExtrudeGeometry(corrugation,{depth:1,bevelEnabled:false}).translate(0,0,-.5);
  const rails = new T.InstancedMesh(beam, steel, (stations.length - 1) * 2);
  const posts = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), postsMaterial, Math.ceil((stations.length - 1) / 2) * 2);
  rails.castShadow = true;
  rails.receiveShadow = true;
  posts.receiveShadow = true;
  const railCells:Array<{beam:T.InstancedMesh;far:T.InstancedMesh;center:T.Vector3}>=[];
  let beamIndex = 0, postIndex = 0;
  for (const sign of [-1, 1]) {
    for (let i = 1; i < stations.length; i++) {
      const a = side(stations[i - 1], sign * railOffset, .61);
      const b = side(stations[i], sign * railOffset, .61);
      const delta = b.clone().sub(a);
      const length = delta.length() + .13;
      const center = a.clone().lerp(b, .5);
      const z=delta.normalize(),x=new T.Vector3(z.z,0,-z.x).normalize();
      const basis=new T.Matrix4().makeBasis(x,new T.Vector3().crossVectors(z,x),z);
      const quaternion=new T.Quaternion().setFromRotationMatrix(basis);
      setInstance(rails, beamIndex++, center, new T.Vector3(.17,.34,length), sign>0?quaternion:quaternion.clone().multiply(new T.Quaternion().setFromAxisAngle(T.Object3D.DEFAULT_UP,Math.PI)));
      if (i % 2 === 1) setInstance(posts, postIndex++, a.clone().add(new T.Vector3(0,-.22,0)), new T.Vector3(.13,.82,.16));
      world.createCollider(RAPIER.ColliderDesc.cuboid(.105,.49,length * .5)
        .setTranslation(center.x, center.y - .18, center.z).setRotation(quaternion).setFriction(.37).setRestitution(.13));
    }
  }

  // Partition the loop before rendering. Only rail cells near the car need the corrugated section.
  const span=48,farBeam=new T.BoxGeometry(1,1,1),matrix=new T.Matrix4();
  for(const [source,perSide] of [[rails,stations.length-1],[posts,Math.ceil((stations.length-1)/2)]] as const){
    for(let side=0;side<2;side++)for(let i=0;i<perSide;i+=span){
      const count=Math.min(span,perSide-i);
      const chunk=new T.InstancedMesh(source.geometry,source.material,count);
      const far=source===rails?new T.InstancedMesh(farBeam,steel,count):null;
      for(let j=0;j<count;j++){source.getMatrixAt(side*perSide+i+j,matrix);chunk.setMatrixAt(j,matrix);far?.setMatrixAt(j,matrix);}
      chunk.castShadow=source===rails;chunk.receiveShadow=true;scene.add(chunk);chunk.computeBoundingSphere();
      if(far){far.receiveShadow=true;scene.add(far);railCells.push({beam:chunk,far,center:chunk.boundingSphere!.center});}
    }
  }
  rails.dispose();posts.dispose();
  bridgeStructure(scene,world);
  // Sample the actual triangle surface under roots and shrubs, including steep banks.
  const {width:gw,height:gh,widthSegments:nx,heightSegments:nz}=ground.parameters;
  const originX=positions.getX(0),originZ=positions.getZ(0);
  const groundY=(x:number,z:number)=>{
    const ix=T.MathUtils.clamp((x-originX)*nx/gw,0,nx-.0001),iz=T.MathUtils.clamp((z-originZ)*nz/gh,0,nz-.0001);
    const k=Math.floor(iz)*(nx+1)+Math.floor(ix),u=ix%1,v=iz%1,row=nx+1;
    return u+v<=1?positions.getY(k)*(1-u-v)+positions.getY(k+1)*u+positions.getY(k+row)*v:
      positions.getY(k+row+1)*(u+v-1)+positions.getY(k+row)*(1-u)+positions.getY(k+1)*(1-v);
  };
  const vergeCells=roadsidePlanting(scene,rng(419),alpine.rock,alpine.rockN,groundY);
  const updateForest=await plantForest(scene,rng(915),asset,groundY);
  buildPaddock(scene,signTexture);
  addSponsorBoards(scene,groundY);

  for (const length of [150, 100, 50]) {
    const ss=sampleAt(surveyMeters[6]-length);
    const pos=side(ss,8.88,1.20);
    fixedBox(scene, new T.Vector3(pos.x,pos.y-.75,pos.z), new T.Vector3(.12,1.6,.12), postsMaterial);
    const board = new T.Mesh(new T.PlaneGeometry(1.28,.48),
      new T.MeshStandardMaterial({ map: signTexture(String(length), 'METRES'), roughness: .85, side: T.DoubleSide }));
    board.position.copy(pos);
    scene.add(board);
  }

  placeTurnSigns(scene);
  placeCheckpointMarkers(scene,wear);
  return (eye:T.Vector3)=>{
    for(const m of vergeCells){const sphere=m.boundingSphere!;m.visible=eye.distanceToSquared(sphere.center)<(110+sphere.radius)**2;}
    for(const r of railCells){r.beam.visible=r.center.distanceToSquared(eye)<175*175;r.far.visible=!r.beam.visible;}
    updateForest(eye);
  };
}
