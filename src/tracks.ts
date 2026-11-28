import { Vector3 } from 'three';
import { maxPlayers } from '../shared/game.ts';
import {
  defaultTrack, trackIdentities, type TrackId,
} from '../shared/tracks.ts';
import {
  checkpointGates, SECTOR_LAYOUT_ID, sectorBoundaryIndices,
} from './lap-timing.ts';
import {
  courseLength, grid, gridRotation, lineDistance, nearestStation, oppositeGrid, roadHalfWidth, sampleAt,
  section, startLine, stations, type Station,
} from './track.ts';
import { mountainAlignment, mountainRegionAt, mountainSectors, mountainShoulderWidth } from './pineglass-v2.ts';
import { mountainDust, type DustProfile } from './pineglass-dust-profile.ts';
import { compactedGravel, type TrackSurface } from './track-surface.ts';

type Rotation = { x: number; y: number; z: number; w: number };
export type TrackSpawn = {
  position: Vector3;
  rotation: Rotation;
  surface?: TrackSurface;
};
export type TimingGate = Station & { halfWidth: number };
type TrackEnvironment = {
  scenery: 'alpine'|'pineglass-mountain';
  panorama: boolean;
  background: number;
  fog: readonly [color:number,near:number,far:number];
  hemisphere: readonly [sky:number,ground:number];
  sunIntensity: number;
  viewDistance: number;
};
type RegisteredTrack = typeof trackIdentities[TrackId];
type StageCourse = Extract<RegisteredTrack, {kind: 'stage'}> & {timingShoulderWidth: (distance: number) => number};
export type TrackDefinition = (Extract<RegisteredTrack, {kind: 'circuit'}> | StageCourse) & {
  length: number;
  startDistance: number;
  finishDistance: number;
  width: readonly [number, number];
  elevation: readonly [number, number];
  surfaceName: string;
  cornerCount: number;
  description: string;
  timingLayout: string;
  dust?: DustProfile;
  grid: readonly TrackSpawn[];
  gates: readonly TimingGate[];
  sectors: readonly [number, number];
  minimap: readonly Station[];
  sampleAt: (distance: number) => TimingGate;
  project: (x: number, z: number) => { station:number; lateral:number; distance:number };
  regionAt: (x: number, z: number) => string;
  environment: TrackEnvironment;
};

const alpineAt = (distance: number) => ({ ...sampleAt(distance), halfWidth: roadHalfWidth });
function buildGrid(
  sampler: (distance: number) => { p: Vector3; right: Vector3; forward: Vector3 },
  frontDistance: number,
  rowSpacing: number,
  surface?: TrackSurface,
): readonly TrackSpawn[] {
  const spawns: TrackSpawn[] = [];
  for (let slot = 0; slot < maxPlayers; slot++) {
    const row = Math.floor(slot / 2);
    const lateral = slot % 2 === 0 ? 1.85 : -1.85;
    const station = sampler(frontDistance - row * rowSpacing);
    const yaw = Math.atan2(-station.forward.x, -station.forward.z);
    const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    spawns.push({
      position: station.p.clone().addScaledVector(station.right, lateral),
      rotation,
      ...(surface ? { surface } : {}),
    });
  }
  return spawns;
}
function alpineGrid(): readonly TrackSpawn[] {
  const rest = buildGrid(sampleAt, lineDistance - 58, 8).slice(2);
  return [
    { position: grid, rotation: gridRotation },
    { position: oppositeGrid, rotation: gridRotation },
    ...rest,
  ];
}
function gravelGrid(sampleAt: TrackDefinition['sampleAt']): readonly TrackSpawn[] {
  return buildGrid(sampleAt, -5, 8, compactedGravel);
}

export const tracks: Record<TrackId, TrackDefinition> = {
  [defaultTrack]: {
    ...trackIdentities[defaultTrack],
    length: courseLength, startDistance: lineDistance, finishDistance: lineDistance+courseLength,
    width: [11.2, 11.2], elevation: [1.55, 92.16], surfaceName: 'Asphalt', cornerCount: 14,
    description: 'Fast asphalt, steep climbs and linked corners across an Alpine ridge.',
    timingLayout: SECTOR_LAYOUT_ID, grid: alpineGrid(),
    gates: [startLine,...checkpointGates].map(g=>({...g, halfWidth:roadHalfWidth})),
    sectors: sectorBoundaryIndices, minimap: stations, sampleAt: alpineAt,
    project: (x,z)=>{
      const {index,distance}=nearestStation(x,z),s=stations[index];
      return {station:s.distance,lateral:(x-s.p.x)*s.right.x+(z-s.p.z)*s.right.z,distance};
    },
    regionAt: (x,z)=>section(nearestStation(x,z).index),
    environment: {scenery:'alpine',panorama:true,background:0x829db1,fog:[0x7e897c,480,1760],
      hemisphere:[0xe2ebf5,0x978d77],sunIntensity:2.35,viewDistance:2200},
  },
  'pineglass-run-v2': {
    ...trackIdentities['pineglass-run-v2'],
    length:mountainAlignment.length,startDistance:0,finishDistance:mountainAlignment.finish,
    width:[8.6,11.2],elevation:[239,470],surfaceName:'Gravel',cornerCount:mountainAlignment.bends.length,
    description:'Quarry bends, a long mountain viaduct and an uphill hairpin.',
    timingLayout:'pineglass-v2-phase1',dust:mountainDust,timingShoulderWidth:mountainShoulderWidth,grid:gravelGrid(mountainAlignment.sampleAt),
    gates:mountainAlignment.gates,sectors:mountainSectors,minimap:mountainAlignment.stations,
    sampleAt:mountainAlignment.sampleAt,project:mountainAlignment.project,
    regionAt:(x,z)=>mountainRegionAt(mountainAlignment.project(x,z).station),
    environment:{scenery:'pineglass-mountain',panorama:false,background:0xc2d1d3,fog:[0xc2d1d3,560,2130],
      hemisphere:[0xe7f1ff,0xaca18d],sunIntensity:2.12,viewDistance:2480},
  },
};
