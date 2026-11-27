import * as T from 'three';
import { weatheredConcrete } from './pineglass-materials.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { mountainAlignment as route, mountainGorge, mountainShoulderWidth, mountainUndulation } from './pineglass-v2.ts';

type Side = -1 | 1;
type ProtectionRun = {
  name: string;
  start: number;
  end: number;
  side: Side;
  style: 'steel' | 'timber' | 'retaining';
  parapet?: readonly [start: number, end: number];
};

const gorgeParapet=[mountainGorge.deckStart-15,mountainGorge.deckEnd+17] as const;

export const mountainProtection: readonly ProtectionRun[] = [
  {name:'Quarry braking and hook', start:459,end:719,side:-1,style:'retaining'},
  {name:'Quarry left arc protection', start:693,end:803,side:1,style:'steel'},
  {name:'Quarry first reverse', start:771,end:874,side:-1,style:'steel'},
  {name:'Quarry second left arc', start:821,end:946,side:1,style:'steel'},
  {name:'Quarry tightening exit', start:929,end:1037,side:-1,style:'steel'},
  {name:'Skyline crest', start:1456, end:1844, side:-1, style:'steel'},
  {name:'Skyline descent and Spruce Bowl', start:1800,end:2344,side:1,style:'steel'},
  {name:'Spruce cutback', start:2316,end:2434,side:-1,style:'retaining'},
  {name:'Cliffside through gorge exit', start:2424,end:4145,side:1,style:'steel',parapet:gorgeParapet},
  {name:'Cliffside, gorge and Cairn Hairpin', start:3235,end:4364,side:-1,style:'steel',parapet:gorgeParapet},
  {name:'Ridge Switch climb', start:4342,end:4500,side:1,style:'steel'},
  {name:'Ridge crest', start:4493, end:4888, side:-1, style:'steel'},
  {name:'Watchtower double-left', start:5027,end:5357,side:1,style:'steel'},
  {name:'Valley approach', start:5467, end:5707, side:1, style:'timber'},
  {name:'Valley descent and hairpin', start:5470, end:6131, side:-1, style:'retaining'},
  {name:'Lower valley outside', start:6102,end:6446,side:1,style:'steel'},
];

const {smoothstep} = T.MathUtils;
export const mountainBarrierFriction = .24;

export function protectionSection(run: ProtectionRun, distance: number) {
  const station = route.sampleAt(distance);
  const lengthToEnd = Math.min(distance-run.start, run.end-distance);
  const taper = smoothstep(lengthToEnd, 0, 18);
  const shoulderOffset = station.halfWidth + mountainShoulderWidth(distance)-.38;
  const across = run.side * (shoulderOffset + (1-taper) * .72);
  const edge = station.p.clone().addScaledVector(station.right, across);
  edge.y += .014 + mountainUndulation(distance, across) - .065;
  const right = new T.Vector3(station.right.x * run.side, 0, station.right.z * run.side);
  const deck = run.parapet;
  const raised = deck ? smoothstep(distance,deck[0]-12,deck[0])*(1-smoothstep(distance,deck[1],deck[1]+12)) : 0;
  const fullHeight = run.style === 'retaining' ? 1.12 : .92+.20*raised;
  return {edge, right, height: T.MathUtils.lerp(.44,fullHeight,taper)};
}

// Sweeping a closed section keeps the road-facing face continuous through joints.
// Rendered sections use the same profile origin and taper as the collision solid.
function sweep(run: ProtectionRun, profile: readonly (readonly [number, number])[], from=run.start, to=run.end) {
  const steps = Math.ceil((to-from)/1.5);
  const count = profile.length;
  const vertices: number[] = [], indices: number[] = [];
  const face = (a: number, b: number, c: number) => {
    if (run.side > 0) indices.push(a, b, c);
    else indices.push(c, b, a);
  };
  for (let i=0; i<=steps; i++) {
    const {edge, right, height} = protectionSection(run, T.MathUtils.lerp(from,to,i/steps));
    for (const [across, y] of profile) {
      const p = edge.clone().addScaledVector(right, across);
      vertices.push(p.x, p.y+y*height, p.z);
    }
    if (i===0) continue;
    for (let j=0; j<count; j++) {
      const a=(i-1)*count+j, b=(i-1)*count+(j+1)%count;
      face(a,b,a+count);
      face(b,b+count,a+count);
    }
  }
  for (let j=1; j<count-1; j++) {
    face(0,j+1,j);
    face(steps*count,steps*count+j,steps*count+j+1);
  }
  return {vertices:new Float32Array(vertices), indices:new Uint32Array(indices)};
}

const solid = [[0,-.3],[0,1],[.26,1],[.26,-.3]] as const;
const steelProfile = [[0,.48],[-.022,.58],[.035,.71],[-.022,.87],[0,1],[.10,1],[.12,.49]] as const;
const timberProfile = [[0,.48],[0,1],[.19,1],[.19,.48]] as const;
const parapetProfile = [[0,-.18],[0,1],[.26,1],[.32,-.18]] as const;
const retainingProfile = [[.32,-.3],[0,1],[.32,1],[.47,-.3]] as const;
const lowerChannel = [[.018,.08],[.018,.27],[.13,.27],[.13,.08]] as const;

export function addMountainProtectionColliders(world: RAPIER.World) {
  return mountainProtection.map(run => {
    const section = run.style === 'retaining' ? retainingProfile : solid;
    const {vertices, indices} = sweep(run,section);
    const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(vertices,indices,RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(mountainBarrierFriction).setRestitution(0));
    return {run, collider};
  });
}

export function buildMountainProtection(root: T.Object3D, world: RAPIER.World) {
  addMountainProtectionColliders(world);
  const galvanized = new T.MeshStandardMaterial({color:0x8c9ca0,metalness:.65,roughness:.46,side:T.DoubleSide});
  const concrete = weatheredConcrete(new T.MeshStandardMaterial({color:0x96948a,roughness:.92,side:T.DoubleSide}));
  const cap = new T.MeshStandardMaterial({color:0x667c7e,metalness:.48,roughness:.56,side:T.DoubleSide});
  const wood = new T.MeshStandardMaterial({color:0x6c5137,roughness:.96,side:T.DoubleSide});
  const red = new T.MeshStandardMaterial({color:0xc84927,emissive:0x782210,emissiveIntensity:.25,roughness:.73});
  const postGeometry = new T.BoxGeometry(1,1,1);
  const dummy = new T.Object3D();
  const railMeshes = new Map<string,{geometries:T.BufferGeometry[];material:T.Material}>();
  const addSweep = (run: ProtectionRun, profile: Parameters<typeof sweep>[1], material: T.Material, from=run.start, to=run.end) => {
    const {vertices, indices} = sweep(run,profile,from,to);
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(vertices,3));
    geometry.setIndex(new T.BufferAttribute(indices,1));
    geometry.computeVertexNormals();
    const midpoint=route.sampleAt((from+to)/2).p;
    const key=[material.id,Math.floor(midpoint.x/320),Math.floor(midpoint.z/320)].join(',');
    const batch=railMeshes.get(key);
    if(batch)batch.geometries.push(geometry);
    else railMeshes.set(key,{geometries:[geometry],material});
  };
  for (const run of mountainProtection) {
    const group = new T.Group();
    group.name = run.name + ' protection';
    root.add(group);
    const timber = run.style === 'timber';
    if (run.style === 'retaining') {
      addSweep(run,retainingProfile,concrete);
      addSweep(run,[[.019,.94],[.019,1.045],[.34,1.045],[.34,.94]],cap);
      continue;
    }
    const rail = (from: number, to: number) => {
      addSweep(run,timber ? timberProfile : steelProfile,timber ? wood : galvanized,from,to);
      addSweep(run,lowerChannel,timber ? wood : cap,from,to);
    };
    const deck=run.parapet;
    if (deck) {
      rail(run.start,deck[0]);
      addSweep(run,parapetProfile,concrete,deck[0],deck[1]);
      addSweep(run,[[.025,.93],[.025,1.04],[.28,1.04],[.28,.93]],cap,deck[0],deck[1]);
      rail(deck[1],run.end);
    } else rail(run.start,run.end);

    const step = timber ? 3.2 : 4.1;
    const count = Math.floor((run.end-run.start-3)/step)+1;
    const stations = Array.from({length:count},(_,i)=>run.start+1.5+i*step);
    const support = deck ? stations.filter(d=>d<deck[0]||d>deck[1]) : stations;
    const posts = new T.InstancedMesh(postGeometry,timber ? wood : cap,support.length);
    const reflectors = new T.InstancedMesh(postGeometry,red,Math.ceil(count/2));
    support.forEach((d,i)=>{
      const {edge,right,height}=protectionSection(run,d);
      const s=route.sampleAt(d);
      dummy.rotation.y=Math.atan2(-s.forward.x,-s.forward.z);
      dummy.position.copy(edge).addScaledVector(right,.15);
      dummy.position.y+=height*.34;
      dummy.scale.set(timber?.19:.11,height*1.45,timber?.19:.16);
      dummy.updateMatrix();
      posts.setMatrixAt(i,dummy.matrix);
    });
    for(let i=0;i<count;i+=2){
      const d=stations[i];
      const {edge,right,height}=protectionSection(run,d);
      const s=route.sampleAt(d);
      dummy.rotation.y=Math.atan2(-s.forward.x,-s.forward.z);
      dummy.position.copy(edge).addScaledVector(right,-.024);
      dummy.position.y+=height*.86;
      dummy.scale.set(.024,.095,.19);
      dummy.updateMatrix();
      reflectors.setMatrixAt(i/2,dummy.matrix);
    }
    posts.receiveShadow=true;
    group.add(posts,reflectors);
  }
  for(const {geometries,material} of railMeshes.values()){
    const geometry=geometries.length===1?geometries[0]:mergeGeometries(geometries)!;
    if(geometries.length>1)for(const source of geometries)source.dispose();
    geometry.computeBoundingSphere();
    const mesh=new T.Mesh(geometry,material);
    mesh.name='Pineglass protection surfaces';
    mesh.receiveShadow=true;
    root.add(mesh);
  }
}
