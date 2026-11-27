import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { ObserverCamera, inspectObserverRoad } from '../src/observer-camera.ts';
import { tracks } from '../src/tracks.ts';

test('observer flight integrates the same acceleration and stopping distance across frame rates', () => {
  const drive = (frames) => {
    const camera = new PerspectiveCamera();
    camera.rotation.set(.52, 1, .16, 'YXZ');
    const initial = camera.quaternion.clone();
    const observer = new ObserverCamera(camera);
    observer.begin();
    assert.deepEqual(camera.quaternion.toArray(), initial.toArray());
    observer.keydown('KeyW');
    for (let i = 0; i < frames; i++) observer.step(1 / frames);
    assert.ok(camera.position.y > 10);
    observer.keyup('KeyW');
    for (let i = 0; i < frames; i++) observer.step(1 / frames);
    return camera.position;
  };
  assert.ok(drive(10).distanceTo(drive(144)) < 1e-8);
});

test('road readout warns about separate stacked sections and ranks by elevation', () => {
  const forward = new Vector3(0, 0, -1);
  const points = [
    [0, -20, 0, 0], [40, 20, 0, 0],
    [100, 20, 20, 50], [160, -20, 20, 50],
    [210, -20, 20, 0], [250, 20, 20, 0],
  ].map(([distance, x, y, z]) => ({distance, p: new Vector3(x, y, z), forward, halfWidth: 4.4}));
  const sampleAt = (distance) => ({
    p: new Vector3(0, distance > 200 ? 20 : 0, 0), forward, halfWidth: 4.4,
  });
  const track = {startDistance: 0, minimap: points, sampleAt};
  const lower = inspectObserverRoad(track, new Vector3(0, 2, 0));
  const upper = inspectObserverRoad(track, new Vector3(0, 23, 0));
  assert.equal(lower.distance, 20);
  assert.equal(upper.distance, 230);
  assert.equal(lower.ambiguous, true);
  assert.equal(upper.ambiguous, true);
});

test('Pineglass bridge has an overhead warning and observer gate jumps stop at stage endpoints', () => {
  const track = tracks['pineglass-run-v2'];
  const eye = track.sampleAt(3800).p.clone();
  eye.y -= 20;
  const under = inspectObserverRoad(track, eye);
  assert.equal(under.overhead, true);
  assert.ok(Math.abs(under.station - 3800) < 3);
  assert.ok(Number.isFinite(under.grade));

  const camera = new PerspectiveCamera();
  camera.position.copy(track.grid[0].position);
  const observer = new ObserverCamera(camera);
  observer.begin();
  assert.equal(observer.jump(track, -1), 0);
  for (let index = 1; index < track.gates.length; index++) assert.equal(observer.jump(track, 1), index);
  assert.equal(observer.jump(track, 1), track.gates.length - 1);
  assert.ok(camera.position.distanceTo(track.gates.at(-1).p) < 12);
  assert.equal(observer.jump(track, -1), track.gates.length - 2);
});
