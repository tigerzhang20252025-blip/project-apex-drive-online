export const trackIdentities = {
  'alpine-proving-ground': {
    id: 'alpine-proving-ground', revision: 'alpine-g7-g14-v1', name: 'Alpine Proving Ground', kind: 'circuit',
  },
  'pineglass-run-v2': {
    id: 'pineglass-run-v2', revision: 'mountain-viaduct-v3', name: 'Pineglass Run 2.0', kind: 'stage',
  },
} as const;

export type TrackId = keyof typeof trackIdentities;
export type TrackIdentity = {
  id: TrackId;
  revision: string;
  name: string;
  kind: 'circuit' | 'stage';
};
export const defaultTrack = 'alpine-proving-ground';
export const isTrackId = (value: unknown): value is TrackId =>
  typeof value === 'string' && Object.hasOwn(trackIdentities, value);

export const attemptName = (track: TrackIdentity) => track.kind === 'stage' ? 'stage' : 'lap';
export const challengeName = (track: TrackIdentity) => track.kind === 'stage' ? 'Best Stage Challenge' : 'Best Lap Challenge';
