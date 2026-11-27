import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle, noInput } from '../src/vehicle.ts';
import { courseLength, stations, grid } from '../src/track.ts';

before(() => RAPIER.init());
function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(400,.5,500).setTranslation(0, grid.y - .5, 0).setFriction(.95));
  const car = new Vehicle(world);
  const step = (seconds, inputs = {}) => {
    const control = { ...noInput, ...inputs };
    for (let i = 0; i < seconds * 120; i++) car.update(control);
  };
  step(1.1);
  return { world, car, step };
}

test('mountain route closes and has challenging elevation and length', () => {
  assert.ok(courseLength >= 4900 && courseLength <= 5100, String(courseLength));
  assert.ok(stations[0].p.distanceTo(stations.at(-1).p) < .0001);
  assert.ok(Math.max(...stations.map(({p}) => p.y)) - Math.min(...stations.map(({p})=>p.y)) > 50);
});

test('four contacts, ignition interlock, physical acceleration and steering', () => {
  const { world, car, step } = setup();
  assert.equal(car.contacts, 4);
  step(1, { throttle: 1 });
  assert.ok(car.speed < .15);
  car.setIgnition();
  step(4.5, { throttle: 1 });
  assert.ok(car.signedSpeed > 12 && car.current.position.z < grid.z - 12, `v=${car.signedSpeed.toFixed(1)} z=${car.current.position.z.toFixed(1)}`);
  assert.ok(car.rpm > 2000 && car.gear >= 1);
  const x = car.current.position.x;
  step(1.3, { steer: 1 });
  assert.ok(car.current.position.x > x + 2, `right turn Δx=${car.current.position.x - x}`);
  world.free();
});

test('brake precedes reverse, reset clears velocity and restart clears trip', () => {
  const { world, car, step } = setup();
  car.setIgnition();
  step(4, { throttle: 1 });
  step(.45, { brake: 1 });
  assert.ok(car.signedSpeed > 1 && car.gear > 0);
  step(4.25, { brake: 1 });
  assert.ok(car.signedSpeed < -1 && car.gear === -1, `speed ${car.signedSpeed}, gear ${car.gear}`);
  car.reset();
  assert.ok(Math.abs(car.current.position.z-grid.z)<.00002 && car.speed === 0 && car.running);
  car.reset(true);
  assert.equal(car.travelled, 0);
  assert.equal(car.running, false);
  world.free();
});

test('handbrake prevents launch and manual gear interlock respects road speed', () => {
  const { world, car, step } = setup();
  car.setIgnition();
  step(.8, { throttle: 1, handbrake: true });
  assert.ok(car.speed < .1);
  car.toggleTransmission();
  assert.equal(car.gear, 0);
  car.shift(1);
  step(3.6, { throttle: 1 });
  assert.ok(car.signedSpeed > 8);
  car.shift(-1);
  car.shift(-1);
  assert.equal(car.gear, 0);
  world.free();
});

test('braking transfers spring load to the front axle and increases compression', () => {
  const {world,car,step} = setup();
  car.setIgnition();
  step(4,{throttle:1});
  const frontLoad=()=>car.controller.wheelSuspensionForce(0)+car.controller.wheelSuspensionForce(1);
  const rearLoad=()=>car.controller.wheelSuspensionForce(2)+car.controller.wheelSuspensionForce(3);
  const poweredFront=frontLoad(), powerLength=car.wheelState[0].length;
  step(.42,{brake:.95});
  assert.ok(frontLoad()>poweredFront+400 && frontLoad()>rearLoad(), 'weight moves to the front under braking');
  assert.ok(car.wheelState[0].length<powerLength-.004);
  assert.equal(car.contacts,4);
  world.free();
});

test('traction control limits drive under lateral load and the parking lever holds after pedal release',()=>{
  const {world,car,step}=setup();
  car.setIgnition();
  car.parkingBrake=true;
  step(1.2,{throttle:1});
  assert.ok(car.speed<.12);
  car.parkingBrake=false;
  step(2.5,{throttle:1});
  let active=0;
  const initialFuel=car.fuelLitres;
  for(let i=0;i<210;i++){
    car.update({...noInput,steer:.80,throttle:Math.min(1,i/120)});
    if(car.tcActive)active++;
  }
  assert.ok(active>0 && car.fuelLitres<initialFuel && car.contacts>=3, 'increasing corner-exit demand reaches traction limit');
  car.tractionControl=false;step(.1,{steer:.73,throttle:1});
  assert.equal(car.tcActive,false);
  world.free();
});

test('opposite steering through an S reverses yaw and the rack returns under release',()=>{
  const {world,car,step}=setup();car.setIgnition();
  step(3.6,{throttle:1});
  step(.82,{steer:.42,throttle:.22}); const right=car.body.angvel().y;
  step(1.05,{steer:-.42,throttle:.26}); const left=car.body.angvel().y;
  assert.ok(right<-.15 && left>.15 && car.contacts===4);
  const before=Math.abs(car.steer);step(.3);
  assert.ok(Math.abs(car.steer)<before*.05);
  world.free();
});

test('a right-hand bend loads the outside tires and rolls the sprung body',()=>{
  const {world,car,step}=setup();
  car.setIgnition();step(3.5,{throttle:1});step(1.05,{steer:.57,throttle:.2});
  const q=car.current.rotation;
  const rollDegrees=Math.asin(2*(q.x*q.y+q.w*q.z))*180/Math.PI;
  const load=i=>car.controller.wheelSuspensionForce(i);
  assert.ok(rollDegrees>.7 && rollDegrees<3 && car.contacts===4);
  assert.ok(load(0)>load(1)+500 && load(2)>load(3)+500);
  world.free();
});

test('mechanical ignition sequence, starter delay, electrical guards and moving removal interlock',()=>{
  const {car,step,world}=setup();
  for(const stage of ['OFF','ACC','ON','START']){car.operateKey();assert.equal(car.ignition,stage);}
  step(.30);assert.ok(!car.running&&car.rpm>50&&car.rpm<300);
  step(1.3);assert.ok(car.running&&car.rpm>900&&car.oilPressure>1);
  step(3,{throttle:1});assert.ok(car.boostBar>.15);
  for(let i=0;i<4;i++)car.operateKey(true);
  assert.equal(car.ignition,'OFF');
  car.reset();car.operateKey(true);assert.equal(car.ignition,'OUT');world.free();
});

test('F40 gated manual blocks extreme synchro over-rev, allows mild redline downshift with stronger low-gear engine braking, and matches gear from neutral', () => {
  const { world, car, step } = setup();
  try {
    car.setIgnition();
    step(1.2);
    car.toggleTransmission();
    car.shift(1);
    // Accelerate to ~175 km/h (~48.6 m/s) in 3rd gear
    for (let i = 0; i < 1200 && car.speed * 3.6 < 175; i++) {
      car.update({ ...noInput, throttle: 1 });
      if (car.rpm > car.spec.redline - 450 && car.gear < car.spec.gears.length) car.shift(1);
    }
    assert.ok(car.speed * 3.6 >= 170 && car.gear === 3, `speed=${(car.speed*3.6).toFixed(1)} gear=${car.gear}`);
    // Downshifting to 2nd at ~175 km/h (~9480 rpm > 8150 synchro ceiling) is rejected by synchronizer
    assert.equal(car.shift(-1), 'synchro');
    assert.equal(car.gear, 3);
    // Engaging forward gear from neutral at high speed selects a compatible gear instead of deadlocking at 1st
    car.gear = 0;
    assert.equal(car.shift(1), 'accepted');
    assert.equal(car.gear, 3);

    // Compare 1 s coasting deceleration at ~146 km/h: 2nd gear (~7910 rpm, mild mechanical over-rev) vs 5th gear
    const measureCoast = (gear) => {
      car.reset();
      step(.5);
      car.body.setLinvel({ x: 0, y: 0, z: -146 / 3.6 }, true);
      car.update(noInput);
      car.gear = 3;
      if (gear < 3) assert.equal(car.shift(-1), 'accepted');
      else { car.shift(1); car.shift(1); }
      assert.equal(car.gear, gear);
      step(.3); // let shiftCut complete
      const before = car.speed * 3.6;
      step(1);
      return { drop: before - car.speed * 3.6, rpm: car.rpm };
    };
    const second = measureCoast(2);
    const fifth = measureCoast(5);
    assert.ok(second.drop > fifth.drop + 3, `2nd drop=${second.drop.toFixed(2)} vs 5th drop=${fifth.drop.toFixed(2)}`);
  } finally {
    world.free();
  }
});
