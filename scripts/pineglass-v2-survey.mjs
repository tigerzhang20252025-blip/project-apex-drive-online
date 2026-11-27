import {mountainAlignment as route,mountainCrest,mountainGorge,mountainRegions,mountainSectors} from '../src/pineglass-v2.ts';
import {createMountainGround} from '../src/pineglass-greybox.ts';

const {parts,groundY}=createMountainGround();
const rows=[];
for(const part of parts){
  if(part.kind!=='road')continue;
  // The middle of the road's eleven vertex columns is the mesh centerline.
  for(let i=rows.length?1:0;i<part.vertices.length/33;i++){
    const col=i*33+15;
    const [x,y,z]=part.vertices.slice(col,col+3);
    const left=part.vertices[i*33+1],right=part.vertices[i*33+31];
    rows.push({center:[x,-z,y],rise:right-left});
  }
}
if(rows.length!==route.meshStations.length)throw new Error('Mesh centerline station mismatch');
const mesh=rows.map(({center,rise},i)=>{
  const {distance,halfWidth}=route.meshStations[i];
  return [distance,...center,halfWidth,100*rise/(2*halfWidth)];
});
const gates=route.gates.map(({distance,p,halfWidth})=>[distance,p.x,-p.z,p.y,halfWidth]);
const b=route.sampleAt(mountainGorge.station).p;
const groundProfile=[];
for(let distance=3450;distance<=4490;distance+=2){
  const {p}=route.sampleAt(distance);
  groundProfile.push([distance,groundY(p.x,p.z)]);
}
console.log(JSON.stringify({
  mesh,gates,finish:route.finish,bends:route.bends,regions:mountainRegions,
  crest:mountainCrest,gorge:{...mountainGorge,floor:groundY(b.x,b.z),deck:b.y},sectors:mountainSectors,groundProfile,
}));
