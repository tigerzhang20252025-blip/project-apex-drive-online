import { MathUtils, Vector3 } from 'three';
import { mountainAlignment, mountainGorge } from './pineglass-v2.ts';

const centre = mountainAlignment.sampleAt(mountainGorge.station);
const forward = centre.forward.clone().setY(0).normalize();
const right = centre.right.clone().setY(0).normalize();

function meander(cross: number) {
  return 10*Math.sin(cross*.015)+12*Math.sin(cross*.005);
}

export function gorgeRiverPoint(cross: number, offset = 0) {
  return centre.p.clone().addScaledVector(right,cross).addScaledVector(forward,meander(cross)+offset);
}

export function cutPineglassGorge(x: number, z: number, surface: number) {
  const dx=x-centre.p.x, dz=z-centre.p.z;
  const across=dx*right.x+dz*right.z;
  const along=dx*forward.x+dz*forward.z-meander(across);
  const reach=1-MathUtils.smoothstep(Math.abs(across),280,520);
  const rim=175+10*Math.sin(across*.013)+7*Math.sin(across*.029);
  const wall=1-MathUtils.smoothstep(Math.abs(along),26,rim);
  const bed=centre.p.y-92-across*.026+.9*Math.sin(across*.028);
  const channel=4.5*Math.exp(-((along/11)**2));
  return MathUtils.lerp(surface,Math.min(surface,bed-channel),wall*reach);
}

export function viaductPoint(station: number, lateral: number, height: number): Vector3 {
  const {p,right}=mountainAlignment.sampleAt(station);
  p.addScaledVector(right,lateral);
  p.y+=height;
  return p;
}
