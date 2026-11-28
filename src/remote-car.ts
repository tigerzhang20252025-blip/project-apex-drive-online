import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lightFlags, type CarId, type Seat } from '../shared/game.ts';
import type { Relay } from '../shared/protocol.ts';
import { mirrorExcludedLayer } from './mirrors.ts';
import { RemoteMotion } from './remote-motion.ts';
import { vehicles } from './vehicle-registry.ts';
import type { VehicleSpec } from './vehicle-spec.ts';
import { disposeVisual, type VehicleVisual } from './vehicle-visual.ts';

const hubNames = ['HubFL', 'HubFR', 'HubRL', 'HubRR'] as const;
const shadowCullDistSq = 68 * 68;
const mirrorCullDistSq = 150 * 150;
const popupOpenAngle = 0.80;
const popupSeconds = 0.73;

function buildShadowProxyGeometry(id: CarId): T.BufferGeometry {
  const isR35 = id === 'r35';
  const lower = new T.BoxGeometry(isR35 ? 1.88 : 1.94, isR35 ? 0.56 : 0.46, isR35 ? 4.55 : 4.35);
  lower.translate(0, isR35 ? 0.30 : 0.24, 0);
  const cabin = new T.BoxGeometry(isR35 ? 1.46 : 1.38, isR35 ? 0.48 : 0.36, isR35 ? 2.05 : 1.80);
  cabin.translate(0, isR35 ? 0.78 : 0.62, isR35 ? 0.12 : 0.08);
  const merged = mergeGeometries([lower, cabin])!;
  lower.dispose();
  cabin.dispose();
  return merged;
}

type LightTag = 'head' | 'tail' | 'brake' | 'reverse' | 'signalL' | 'signalR' | 'popupBulb' | 'auxCore';

type LightSet = Record<LightTag, T.MeshStandardMaterial[]>;

type RemoteInstance = {
  group: T.Group;
  wheels: Array<{ pivot: T.Object3D; roller: T.Object3D }>;
  popupPivots: T.Object3D[];
  lights: LightSet;
  ownedMaterials: T.Material[];
  lodMeshes: T.Mesh[];
  shadowMeshes: T.Mesh[];
  nearShadow: boolean;
  nearMirror: boolean;
  popupProgress: number;
  auxIntensity: number;
};

type RemotePeer = {
  slot: Seat;
  model: CarId;
  connected: boolean;
  motion: RemoteMotion;
  instance?: RemoteInstance;
  failed: boolean;
};

export type RemoteDustSource = {
  slot: Seat;
  motion: RemoteMotion;
  spec: VehicleSpec;
};

export type RemoteMarker = {
  slot: Seat;
  position: T.Vector3;
};

export type RemotePeerStats = {
  slot: Seat;
  model: CarId;
  visible: boolean;
  received: number;
  buffered: number;
  progress: number;
  delayMs: number;
  jitterMs: number;
};

function cloneVisible(source: T.Object3D): T.Object3D {
  const copy = source.clone(false);
  for (const child of source.children) {
    if (!child.visible) continue;
    copy.add(cloneVisible(child));
  }
  return copy;
}

function emptyLights(): LightSet {
  return { head: [], tail: [], brake: [], reverse: [], signalL: [], signalR: [], popupBulb: [], auxCore: [] };
}

function cloneExterior(
  template: VehicleVisual,
  id: CarId,
  slot: Seat,
  shadowProxyGeo: T.BufferGeometry,
  shadowProxyMat: T.Material,
): RemoteInstance {
  const group = cloneVisible(template.group) as T.Group;
  group.name = `Remote ${id.toUpperCase()} #${slot}`;
  group.userData.remoteVehicle = id;
  group.userData.remoteSlot = slot;
  group.visible = false;

  const lights = emptyLights();
  const clonedBySource = new Map<T.Material, T.MeshStandardMaterial>();
  const ownedMaterials: T.Material[] = [];
  const lodMeshes: T.Mesh[] = [];
  const shadowMeshes: T.Mesh[] = [];
  const popupPivots: T.Object3D[] = [];

  const cloneLightMaterial = (material: T.Material): T.Material => {
    const tag = material.userData?.remoteLight as LightTag | undefined;
    if (!tag || !(material instanceof T.MeshStandardMaterial)) return material;
    let cloned = clonedBySource.get(material);
    if (!cloned) {
      cloned = material.clone();
      clonedBySource.set(material, cloned);
      ownedMaterials.push(cloned);
      lights[tag].push(cloned);
    }
    return cloned;
  };

  group.traverse(node => {
    if (node.name === 'Popup hinge L' || node.name === 'Popup hinge R') popupPivots.push(node);
    if (!(node instanceof T.Mesh)) return;
    if (Array.isArray(node.material)) {
      node.material = node.material.map(cloneLightMaterial);
    } else if (node.material) {
      node.material = cloneLightMaterial(node.material);
    }
    // High-poly sub-meshes do not cast individual shadow passes; the lightweight
    // Layer-3 car silhouette proxy handles shadows with 1 draw call (24 triangles).
    node.castShadow = false;
    if (!node.userData.shadowOnly) {
      node.layers.set(mirrorExcludedLayer);
      if (!node.userData.mirrorSkip) {
        node.layers.enable(0);
        lodMeshes.push(node);
      }
    }
  });

  const shadowProxy = new T.Mesh(shadowProxyGeo, shadowProxyMat);
  shadowProxy.name = `Remote ${id.toUpperCase()} shadow proxy`;
  shadowProxy.userData.shadowOnly = true;
  shadowProxy.castShadow = true;
  shadowProxy.receiveShadow = false;
  shadowProxy.layers.set(3);
  group.add(shadowProxy);
  shadowMeshes.push(shadowProxy);

  const wheels = hubNames.map(name => {
    const pivot = group.getObjectByName(name)!;
    const roller = pivot.children[0]!;
    return { pivot, roller };
  });

  return {
    group,
    wheels,
    popupPivots,
    lights,
    ownedMaterials,
    lodMeshes,
    shadowMeshes,
    nearShadow: true,
    nearMirror: true,
    popupProgress: 0,
    auxIntensity: 0,
  };
}

function disposeInstance(instance: RemoteInstance) {
  instance.group.removeFromParent();
  for (const material of instance.ownedMaterials) material.dispose();
}

function syncInstanceLights(instance: RemoteInstance, id: CarId, flags: number, dt: number) {
  const { lights } = instance;
  const auxRequested = Boolean(flags & lightFlags.auxiliary);
  if (id === 'f40') {
    instance.popupProgress = T.MathUtils.clamp(
      instance.popupProgress + (auxRequested ? 1 : -1) * dt / popupSeconds,
      0,
      1,
    );
    const angle = popupOpenAngle * T.MathUtils.smoothstep(instance.popupProgress, 0, 1);
    const glow = auxRequested ? T.MathUtils.smoothstep(instance.popupProgress, 0.83, 0.98) : 0;
    for (const pivot of instance.popupPivots) pivot.rotation.x = angle;
    for (const mat of lights.popupBulb) mat.emissiveIntensity = 2.7 * glow;
    for (const mat of lights.head) mat.emissiveIntensity = flags & lightFlags.lights ? 0.78 : 0.015;
    for (const mat of lights.brake) {
      mat.emissiveIntensity = flags & lightFlags.brake ? 2.9 : flags & lightFlags.lights ? 0.52 : 0.07;
    }
    for (const mat of lights.reverse) mat.emissiveIntensity = flags & lightFlags.reverse ? 1.55 : 0;
    for (const mat of lights.signalL) mat.emissiveIntensity = flags & lightFlags.left ? 2.4 : 0.025;
    for (const mat of lights.signalR) mat.emissiveIntensity = flags & lightFlags.right ? 2.4 : 0.025;
  } else {
    instance.auxIntensity = T.MathUtils.damp(instance.auxIntensity, auxRequested ? 1 : 0, 18, dt);
    for (const mat of lights.auxCore) mat.emissiveIntensity = 0.025 + instance.auxIntensity * 2.1;
    for (const mat of lights.head) mat.emissiveIntensity = flags & lightFlags.lights ? 1.25 : 0.04;
    for (const mat of lights.tail) {
      mat.emissiveIntensity = flags & lightFlags.brake ? 2.45 : flags & lightFlags.lights ? 0.64 : 0.16;
    }
    for (const mat of lights.brake) mat.emissiveIntensity = flags & lightFlags.brake ? 1.55 : 0.025;
    for (const mat of lights.signalL) mat.emissiveIntensity = flags & lightFlags.left ? 1.8 : 0.045;
    for (const mat of lights.signalR) mat.emissiveIntensity = flags & lightFlags.right ? 1.8 : 0.045;
  }
}

export class RemoteCar {
  private readonly scene: T.Scene;
  private readonly onLoad: () => void;
  private templates = new Map<CarId, Promise<VehicleVisual>>();
  private shadowProxyGeos = new Map<CarId, T.BufferGeometry>();
  private shadowProxyMat = new T.MeshStandardMaterial({ colorWrite: false, depthWrite: false });
  private peers = new Map<Seat, RemotePeer>();
  private generation = 0;

  constructor(scene: T.Scene, onLoad: () => void) {
    this.scene = scene;
    this.onLoad = onLoad;
  }

  get ready(): boolean {
    if (this.peers.size === 0) return false;
    for (const peer of this.peers.values()) {
      if (peer.connected && !peer.instance) return false;
    }
    return true;
  }

  get failed(): boolean {
    for (const peer of this.peers.values()) {
      if (peer.failed) return true;
    }
    return false;
  }

  get visibleMarkers(): RemoteMarker[] {
    const markers: RemoteMarker[] = [];
    for (const peer of this.peers.values()) {
      if (peer.instance?.group.visible) {
        markers.push({ slot: peer.slot, position: peer.instance.group.position });
      }
    }
    return markers;
  }

  get visiblePosition(): T.Vector3 | undefined {
    for (const peer of this.peers.values()) {
      if (peer.instance?.group.visible) return peer.instance.group.position;
    }
  }

  get dustSources(): RemoteDustSource[] {
    const sources: RemoteDustSource[] = [];
    for (const peer of this.peers.values()) {
      if (peer.instance?.group.visible && peer.motion.dust) {
        sources.push({ slot: peer.slot, motion: peer.motion, spec: vehicles[peer.model].spec });
      }
    }
    return sources;
  }

  get allStats(): RemotePeerStats[] {
    const list: RemotePeerStats[] = [];
    for (const peer of this.peers.values()) {
      list.push({
        slot: peer.slot,
        model: peer.model,
        visible: Boolean(peer.instance?.group.visible),
        received: peer.motion.received,
        buffered: peer.motion.buffered,
        progress: peer.motion.progress,
        delayMs: Math.round(peer.motion.delayMs),
        jitterMs: Math.round(peer.motion.jitter),
      });
    }
    return list.sort((a, b) => a.slot - b.slot);
  }

  get stats() {
    const first = this.allStats[0];
    return first
      ? {
          model: first.model,
          visible: first.visible,
          received: first.received,
          buffered: first.buffered,
          progress: first.progress,
          delayMs: first.delayMs,
          jitterMs: first.jitterMs,
        }
      : { model: undefined, visible: false, received: 0, buffered: 0, progress: 0, delayMs: 0, jitterMs: 0 };
  }

  syncPeers(roster: ReadonlyArray<{ slot: Seat; vehicle: CarId; connected: boolean }>) {
    const keep = new Set<Seat>();
    for (const item of roster) {
      keep.add(item.slot);
      const existing = this.peers.get(item.slot);
      if (!existing) {
        const peer: RemotePeer = {
          slot: item.slot,
          model: item.vehicle,
          connected: item.connected,
          motion: new RemoteMotion(),
          failed: false,
        };
        this.peers.set(item.slot, peer);
        this.attachPeer(peer);
      } else {
        const wasConnected = existing.connected;
        existing.connected = item.connected;
        if (!item.connected && wasConnected) {
          existing.motion.clear();
          if (existing.instance) existing.instance.group.visible = false;
        }
        if (existing.model !== item.vehicle) {
          if (existing.instance) {
            disposeInstance(existing.instance);
            existing.instance = undefined;
          }
          existing.model = item.vehicle;
          existing.failed = false;
          existing.motion.clear();
          this.attachPeer(existing);
        }
      }
    }
    for (const [slot, peer] of this.peers) {
      if (keep.has(slot)) continue;
      if (peer.instance) disposeInstance(peer.instance);
      peer.motion.clear();
      this.peers.delete(slot);
    }
  }

  retryFailed() {
    for (const peer of this.peers.values()) {
      if (!peer.failed) continue;
      peer.failed = false;
      this.attachPeer(peer);
    }
  }

  private loadTemplate(id: CarId): Promise<VehicleVisual> {
    let load = this.templates.get(id);
    if (!load) {
      load = vehicles[id].build().then(async visual => {
        try {
          await visual.load(true);
          return visual;
        } catch (error) {
          disposeVisual(visual);
          throw error;
        }
      });
      this.templates.set(id, load);
    }
    return load;
  }

  private attachPeer(peer: RemotePeer) {
    const id = peer.model;
    const gen = this.generation;
    const load = this.loadTemplate(id);
    void load.then(template => {
      if (gen !== this.generation || this.peers.get(peer.slot) !== peer || peer.model !== id) return;
      if (peer.instance) disposeInstance(peer.instance);
      let proxyGeo = this.shadowProxyGeos.get(id);
      if (!proxyGeo) {
        proxyGeo = buildShadowProxyGeometry(id);
        this.shadowProxyGeos.set(id, proxyGeo);
      }
      const instance = cloneExterior(template, id, peer.slot, proxyGeo, this.shadowProxyMat);
      peer.instance = instance;
      peer.failed = false;
      this.scene.add(instance.group);
      this.onLoad();
    }, () => {
      if (this.templates.get(id) === load) this.templates.delete(id);
      if (gen !== this.generation || this.peers.get(peer.slot) !== peer || peer.model !== id) return;
      peer.failed = true;
      this.onLoad();
    });
  }

  receive(packet: Relay, receiverServerNow?: number) {
    const peer = this.peers.get(packet.slot as Seat);
    if (!peer) return;
    peer.motion.receive(packet, receiverServerNow);
  }

  draw(serverNow: number, dt: number, observerPosition?: T.Vector3) {
    for (const peer of this.peers.values()) {
      const instance = peer.instance;
      if (!instance) continue;
      if (!peer.motion.step(serverNow, dt)) {
        instance.group.visible = false;
        continue;
      }
      instance.group.visible = true;
      instance.group.position.copy(peer.motion.position);
      instance.group.quaternion.copy(peer.motion.rotation);
      const spec = vehicles[peer.model].spec;
      instance.wheels.forEach(({ pivot, roller }, i) => {
        pivot.position.y = spec.mountHeight - peer.motion.suspension[i];
        if (i < 2) pivot.rotation.y = peer.motion.steering[i];
        roller.rotation.x = -peer.motion.wheels[i];
      });
      syncInstanceLights(instance, peer.model, peer.motion.flags, dt);

      if (observerPosition) {
        const distSq = peer.motion.position.distanceToSquared(observerPosition);
        const nearShadow = distSq <= shadowCullDistSq;
        if (nearShadow !== instance.nearShadow) {
          instance.nearShadow = nearShadow;
          for (const mesh of instance.shadowMeshes) mesh.castShadow = nearShadow;
        }
        const nearMirror = distSq <= mirrorCullDistSq;
        if (nearMirror !== instance.nearMirror) {
          instance.nearMirror = nearMirror;
          for (const mesh of instance.lodMeshes) {
            if (nearMirror) mesh.layers.enable(0);
            else mesh.layers.disable(0);
          }
        }
      }
    }
  }

  clear() {
    for (const peer of this.peers.values()) {
      peer.motion.clear();
      if (peer.instance) instanceReset(peer.instance);
    }
  }

  dispose() {
    this.generation++;
    for (const peer of this.peers.values()) {
      if (peer.instance) disposeInstance(peer.instance);
      peer.motion.clear();
    }
    this.peers.clear();
    for (const promise of this.templates.values()) void promise.then(disposeVisual, () => {});
    this.templates = new Map();
    for (const geo of this.shadowProxyGeos.values()) geo.dispose();
    this.shadowProxyGeos.clear();
  }
}

function instanceReset(instance: RemoteInstance) {
  instance.group.visible = false;
  instance.popupProgress = 0;
  instance.auxIntensity = 0;
}
