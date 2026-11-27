import type * as T from 'three';
import type { CarId } from '../multiplayer-poc/src/game.ts';
import type { Relay } from '../multiplayer-poc/src/protocol.ts';
import { RemoteMotion } from './remote-motion.ts';
import { vehicles } from './vehicle-registry.ts';
import { disposeVisual, type VehicleVisual } from './vehicle-visual.ts';

export class RemoteCar {
  private readonly scene: T.Scene;
  private readonly onLoad: () => void;
  private visuals = new Map<CarId, Promise<VehicleVisual>>();
  private visual?: VehicleVisual;
  private selected?: CarId;
  private motion = new RemoteMotion();
  failed = false;

  constructor(scene: T.Scene, onLoad: () => void) {
    this.scene = scene;
    this.onLoad = onLoad;
  }

  get ready() { return Boolean(this.visual); }
  get visiblePosition() { return this.visual?.group.visible ? this.visual.group.position : undefined; }
  get dustSource() {
    if (this.selected && this.visual?.group.visible && this.motion.dust) {
      return { motion: this.motion, spec: vehicles[this.selected].spec };
    }
  }
  get stats() {
    return {
      model: this.selected,
      visible: Boolean(this.visiblePosition),
      received: this.motion.received,
      buffered: this.motion.buffered,
      progress: this.motion.progress,
      delayMs: Math.round(this.motion.delayMs),
      jitterMs: Math.round(this.motion.jitter),
    };
  }

  select(id?: CarId) {
    if (this.selected === id && !this.failed) return;
    this.visual?.group.removeFromParent();
    this.visual = undefined;
    this.selected = id;
    this.failed = false;
    this.clear();
    if (!id) return;
    const cache = this.visuals;
    let load = cache.get(id);
    if (!load) {
      load = vehicles[id].build().then(async visual => {
        try {
          await visual.load(true);
          visual.group.name = 'Remote ' + id.toUpperCase();
          visual.group.userData.remoteVehicle = id;
          visual.group.traverse(node => {
            if (!node.userData.shadowOnly) node.layers.enable(0);
          });
          return visual;
        } catch (error) {
          disposeVisual(visual);
          throw error;
        }
      });
      cache.set(id, load);
    }
    void load.then(visual => {
      if (cache !== this.visuals || id !== this.selected) return;
      visual.group.visible = false;
      this.visual = visual;
      this.scene.add(visual.group);
      this.onLoad();
    }, () => {
      if (cache.get(id) === load) cache.delete(id);
      if (cache !== this.visuals || id !== this.selected) return;
      this.failed = true;
      this.onLoad();
    });
  }

  receive(packet: Relay, receiverServerNow?: number) {
    this.motion.receive(packet, receiverServerNow);
  }

  draw(serverNow: number, dt: number) {
    const visual = this.visual;
    if (!visual) return;
    if (!this.motion.step(serverNow, dt)) {
      visual.group.visible = false;
      return;
    }
    visual.group.visible = true;
    visual.group.position.copy(this.motion.position);
    visual.group.quaternion.copy(this.motion.rotation);
    const spec = vehicles[this.selected!].spec;
    visual.wheels.forEach(({pivot, roller}, i) => {
      pivot.position.y = spec.mountHeight - this.motion.suspension[i];
      if (i < 2) pivot.rotation.y = this.motion.steering[i];
      roller.rotation.x = -this.motion.wheels[i];
    });
    visual.syncExteriorLights(this.motion.flags, dt);
  }

  clear() {
    this.motion.clear();
    if (this.visual) this.visual.group.visible = false;
  }

  dispose() {
    this.select(undefined);
    for (const promise of this.visuals.values()) void promise.then(disposeVisual, () => {});
    this.visuals = new Map();
  }
}
