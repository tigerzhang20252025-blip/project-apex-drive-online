// Deterministic replay driver for evaluating the normal 120 Hz vehicle solver.
import { MathUtils } from 'three';
import { mountainAlignment } from '../src/pineglass-v2.ts';
import { drivingAssists, interpolate } from '../src/vehicle-spec.ts';

const {clamp, lerp, degToRad}=MathUtils;
export const sweepWindows=route=>route.bends.filter(bend=>bend.flat).map(bend=>({...bend,start:route.bends[bend.id-2].exit}));

export function pineglassDriver(car, { gain=1.28, braking=4.25, lookahead=6, lineOffset=0, route=mountainAlignment }={}) {
  const {sampleAt,project,finish}=route, sweeps=sweepWindows(route);
  const {spec}=car, wheelbase=spec.wheels[2].z-spec.wheels[0].z;
  const last=Math.ceil(finish);
  const limits=Array.from({length:last+2},(_,station)=>{
    const {curvature}=sampleAt(station);
    const flat=sweeps.some(bend=>station>=bend.entry&&station<=bend.exit);
    return flat?66:Math.min(66,Math.sqrt((spec.awd?4.95:4.55)/Math.abs(curvature)));
  });
  for(let i=last-1;i>=0;i--){
    const grade=sampleAt(i).forward.y;
    limits[i]=Math.min(limits[i],Math.sqrt(limits[i+1]**2+2*(braking+9.81*grade)));
  }

  function rackLimit(speed){
    return degToRad(interpolate(spec.steering.lock,speed*3.6))*(spec.awd?drivingAssists[car.assistMode].steering:1);
  }
  function input(){
    const {position}=car.current;
    const speed=car.speed;
    const loc=project(position.x,position.z);
    const look=clamp(lookahead+speed*.45,6,30);
    const aim=sampleAt(loc.station+look);
    const target=aim.p;
    if(lineOffset)target.addScaledVector(aim.right,lineOffset);
    const dx=target.x-position.x,dz=target.z-position.z;
    const lateral=-car.direction.z*dx+car.direction.x*dz;
    const curvature=2*lateral/(dx*dx+dz*dz || 1);
    const steer=clamp(gain*Math.atan(wheelbase*curvature)/rackLimit(speed),-1,1);
    // No pace or steering limit outside the normal driver inputs. Open the
    // throttle at the previous corner's geometric exit and hold through the sweep.
    if(sweeps.some(b=>loc.station>=b.start&&loc.station<b.exit))return {steer,throttle:1,brake:0,handbrake:false};
    const station=clamp(loc.station,0,last);
    const planned=lerp(limits[Math.floor(station)],limits[Math.floor(station)+1],station%1);
    return {steer,throttle:clamp((planned-speed)*.64,0,1),brake:clamp((speed-planned+.65)*.40,0,.9),handbrake:false};
  }

  return {input,rackLimit};
}
