import { MathUtils, Vector3 } from 'three';

const { clamp, degToRad, lerp, smoothstep } = MathUtils;

type AlignmentConfig = {
  alignment: ReadonlyArray<readonly [gap:number,radius:number,angle:number,transition:number,curvatureBias?:number]>;
  heights: ReadonlyArray<readonly [station:number,elevation:number]>;
  headingDegrees: number;
  origin?: readonly [east:number,north:number];
  finishStraight: number;
  gateDistances: readonly number[];
  flatCorners: readonly number[];
  baseHalfWidth: number;
  leadIn: number;
  runoff: number;
  verticalFeatures?: ReadonlyArray<readonly [start:number,end:number,rise:number]>;
  profile?: (station:number) => {halfWidthDelta:number;crossfallDelta:number};
  sightlineEasing?: ReadonlyArray<readonly [start:number,end:number,depth:number]>;
};

export function createStageAlignment({
  alignment, heights, headingDegrees, finishStraight, gateDistances, flatCorners, baseHalfWidth, leadIn, runoff,
  sightlineEasing=[],verticalFeatures=[],profile,origin=[0,0],
}: AlignmentConfig) {
  let previousExit = 0, enteringHeading = degToRad(headingDegrees);
  const bends = alignment.map(([gap, radius, angle, transition, curvatureBias=0], i) => {
    const entry = previousExit + gap;
    const radians = degToRad(angle);
    const length = radius * Math.abs(radians) + transition;
    const exit = entry + length;
    const heading = enteringHeading;
    const flat = flatCorners.includes(i + 1);
    const halfWidth = flat ? 5.3 : radius < 25 ? 4.7 : radius < 48 ? 4.5 : baseHalfWidth;
    previousExit = exit;
    enteringHeading += radians;
    return { id: i+1, entry, exit, length, transition, curvatureBias, radius, heading, turn: Math.sign(angle), angle, halfWidth, flat };
  });
  const finish = previousExit + finishStraight;
  const end = finish + runoff;
  const gates = [...gateDistances, finish];


  // Solve for the knot derivatives of the clamped cubic using its tridiagonal system.
  const slopes = (() => {
    const upper: number[] = [], rhs: number[] = [];
    const last = heights.length - 1;
    for (let i = 0; i <= last; i++) {
      if (i === 0 || i === last) { upper.push(0); rhs.push(0); continue; }
      const [x, y] = heights[i];
      const h0 = x - heights[i-1][0], h1 = heights[i+1][0] - x;
      const diag = 2*(h0+h1) - h1*upper[i-1];
      upper.push(h0/diag);
      rhs.push((3*(h1*(y-heights[i-1][1])/h0 + h0*(heights[i+1][1]-y)/h1) - h1*rhs[i-1])/diag);
    }
    for (let i = last - 1; i >= 0; i--) rhs[i] -= upper[i]*rhs[i+1];
    return rhs;
  })();

  const verticalAdjustments=[
    ...sightlineEasing.map(([from,to,depth])=>[from,to,-depth] as const),
    ...verticalFeatures,
  ];

  function elevation(distance: number) {
    if (distance <= 0) return { y: heights[0][1], grade: 0 };
    const i = heights.findIndex(([d]) => d > distance) - 1;
    const [d0, y0] = heights[i], [d1, y1] = heights[i+1];
    const span = d1-d0, t = (distance-d0)/span;
    const m0 = slopes[i]*span, m1 = slopes[i+1]*span;
    const a = 2*(y0-y1)+m0+m1, b = 3*(y1-y0)-2*m0-m1;
    let y=((a*t+b)*t+m0)*t+y0, grade=((3*a*t+2*b)*t+m0)/span;
    for(const [from,to,rise] of verticalAdjustments){
      if(distance<=from||distance>=to)continue;
      const phase=Math.PI*(distance-from)/(to-from), weight=Math.sin(phase);
      y+=rise*weight**4;
      grade+=rise*4*weight**3*Math.cos(phase)*Math.PI/(to-from);
    }
    return { y, grade };
  }

  function crossSection(distance: number) {
    let heading = degToRad(headingDegrees), curvature = 0, bank = 0, halfWidth = baseHalfWidth;
    for (const bend of bends) {
      if (distance < bend.entry - 24) break;
      if (distance >= bend.exit) heading = bend.heading + degToRad(bend.angle);
      const widthBlend = clamp(Math.min(distance - bend.entry + 24, bend.exit + 24 - distance)/24, 0, 1);
      halfWidth = Math.max(halfWidth, lerp(baseHalfWidth, bend.halfWidth, (1-Math.cos(Math.PI*widthBlend))/2));
      if (distance < bend.entry || distance >= bend.exit) continue;
      const u = distance-bend.entry, t = bend.transition, l = bend.length;
      const ramp = Math.min(1, u/t, (l-u)/t);
      const integral = u < t ? u*u/(2*t) : u <= l-t ? u-t/2 : l-t-(l-u)**2/(2*t);
      // An odd, tapered curvature term redistributes the turn without changing its
      // total angle, length or tangent at either end.
      const position = 2*u/l-1;
      const envelope = 1-position*position;
      const offset = bend.curvatureBias;
      curvature = bend.turn*(ramp+3*offset*position*envelope**2)/bend.radius;
      heading = bend.heading + bend.turn*(integral-offset*l/4*envelope**3)/bend.radius;
      if (bend.flat) bank = .02*bend.turn*(1-Math.cos(Math.PI*ramp))/2;
    }
    if(profile){
      const {halfWidthDelta,crossfallDelta}=profile(distance);
      halfWidth+=halfWidthDelta;
      bank+=crossfallDelta;
    }
    // Widen the runoff toward an open turnaround beyond the timed course.
    halfWidth += 5.2*smoothstep(distance-finish, 154, 211);
    return { heading, curvature, bank, halfWidth };
  }

  const steps = Math.ceil(finish*2);
  const sampleSpacing = finish/steps;
  const east = new Float64Array(steps+1), north = new Float64Array(steps+1);
  [east[0],north[0]]=origin;
  let previous = crossSection(0), previousY=heights[0][1], physicalLength = 0;
  for (let i = 1; i <= steps; i++) {
    const s = i*sampleSpacing;
    const next = crossSection(s), {y} = elevation(s);
    const dx = (Math.cos(previous.heading)+Math.cos(next.heading))*sampleSpacing/2;
    const dn = (Math.sin(previous.heading)+Math.sin(next.heading))*sampleSpacing/2;
    east[i] = east[i-1]+dx; north[i] = north[i-1]+dn;
    physicalLength += Math.hypot(dx, dn, y-previousY);
    previous = next; previousY = y;
  }
  const length = physicalLength;

  function sampleAt(requested: number) {
    const distance = clamp(requested, leadIn, end);
    const { heading, curvature, bank, halfWidth } = crossSection(distance);
    const { y, grade } = elevation(distance);
    const position = clamp(distance,0,finish)/sampleSpacing;
    const i = Math.min(steps-1,Math.floor(position)), t = position-i;
    const tangent = distance - clamp(distance,0,finish);
    const dx = Math.cos(heading), dz = -Math.sin(heading);
    return {
      distance, halfWidth,
      p: new Vector3(lerp(east[i],east[i+1],t)+tangent*dx, y, -lerp(north[i],north[i+1],t)+tangent*dz),
      forward: new Vector3(dx, grade, dz).normalize(),
      right: new Vector3(-dz, bank, dx),
      curvature: -curvature,
    };
  }

  const timingGates = gates.map(sampleAt);

  function drawStations(first: number, last: number, spacing: number) {
    const count = Math.ceil((last-first)/spacing);
    return Array.from({ length: count+1 }, (_, i) => sampleAt(first+(last-first)*i/count));
  }
  const stations = drawStations(0, finish, 2);
  const meshStations = drawStations(leadIn,end,1.35);

  type Node = { index: number; axis: 'x'|'z'; low?: Node; high?: Node };
  function indexStations(ids: number[], axis: Node['axis']): Node | undefined {
    if (!ids.length) return;
    ids.sort((a,b) => meshStations[a].p[axis]-meshStations[b].p[axis]);
    const middle = Math.floor(ids.length/2), next = axis === 'x' ? 'z' : 'x';
    return {index:ids[middle], axis, low:indexStations(ids.slice(0,middle),next), high:indexStations(ids.slice(middle+1),next)};
  }
  const tree = indexStations(meshStations.map((_,i)=>i), 'x');

  function project(x: number, z: number) {
    let closest = 0, best = Infinity;
    function search(node?: Node) {
      if (!node) return;
      const { p } = meshStations[node.index];
      const dx=x-p.x, dz=z-p.z, d=dx*dx+dz*dz;
      if (d<best) { best=d; closest=node.index; }
      const delta=node.axis==='x'?dx:dz;
      search(delta<0?node.low:node.high);
      if(delta*delta<best)search(delta<0?node.high:node.low);
    }
    search(tree);
    // Project onto the closest adjacent segment of the actual road mesh.
    let station = meshStations[closest].distance, lateral = 0;
    best=Infinity;
    for(let i=Math.max(0,closest-1);i<Math.min(meshStations.length-1,closest+1);i++){
      const a=meshStations[i], b=meshStations[i+1];
      const dx=b.p.x-a.p.x,dz=b.p.z-a.p.z,ox=x-a.p.x,oz=z-a.p.z;
      const t=clamp((ox*dx+oz*dz)/(dx*dx+dz*dz),0,1);
      const qx=ox-dx*t,qz=oz-dz*t,d=qx*qx+qz*qz;
      if(d<best){
        best=d;
        station=lerp(a.distance,b.distance,t);
        lateral=(qz*dx-qx*dz)/Math.hypot(dx,dz);
      }
    }
    return { station, lateral, distance: Math.sqrt(best) };
  }

  return {sampleAt,project,finish,end,length,bends,gates:timingGates,stations,meshStations};
}

export type StageAlignment = ReturnType<typeof createStageAlignment>;
