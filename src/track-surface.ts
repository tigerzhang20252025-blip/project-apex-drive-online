import type { SurfaceName } from './rally-dynamics.ts';

type TireSurface = { rwdGrip: number; awdGrip: number; lateral: number; drive: number; braking: number; rolling: number };
export type TrackSurface = Partial<Record<SurfaceName, TireSurface>>;

// Ratios relative to each car's existing tire specification. These are local
// to Pineglass colliders. The asphalt model and road/shoulder behavior on Alpine stay intact.
export const compactedGravel: TrackSurface = {
  gravel: { rwdGrip: .76, awdGrip: .76, lateral: .91, drive: .91, braking: .87, rolling: .015 },
  dirt: { rwdGrip: .64, awdGrip: .65, lateral: .83, drive: .84, braking: .78, rolling: .023 },
  grass: { rwdGrip: .51, awdGrip: .55, lateral: .73, drive: .78, braking: .72, rolling: .032 },
};
