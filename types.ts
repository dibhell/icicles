import type { ScaleId } from './src/music/scales';

export interface AudioSettings {
  volume: number; // 0 to 1
  low: number; // -24 to 24 (dB)
  mid: number; // -24 to 24 (dB)
  high: number; // -24 to 24 (dB)
  reverbWet: number; // 0 to 1
  baseFrequency: number; // Hz
  pingPongWet: number; // 0 to 1
  sampleGain?: number; // 0..2 multiplier for samples
  compThreshold?: number; // dB
  compRatio?: number;
  compAttack?: number; // seconds
  compRelease?: number; // seconds
  makeupGainDb?: number; // dB
  limiterThreshold?: number; // dB
}

export interface PhysicsSettings {
  tempo: number; // Speed multiplier 0.1 to 3
  gravity: number; // 0 to 1
  buddingChance: number; // 0 to 0.05
  cannibalism: number; // 0 to 1 (Threshold for merging)
  wind: number; // 0 to 1 (Random turbulence intensity)
  reverseChance: number; // 0 to 1 (Probability of reverse sound)
  blackHole: number; // 0 to 1 (Intensity of central gravity)
  doppler: number; // 0 to 1 (Intensity of doppler effect)
  pingPong: number; // 0 to 1 (Amount of delay)
  weakness: number; // 0 to 1 (Rate of decay/popping)
  magneto: number; // 0 to 1 (Magnetic force intensity)
  fragmentation: number; // 0 to 1 (Chance to shatter into particles)
  freeze: number; // 0 to 1 (Viscosity/Freezing effect)
  geometryWarp: number; // 0 to 1 (Room geometry distortion)
  roomWave: number; // 0 to 1 (Room wave animation)
}

export interface MusicSettings {
  root: number; // 0 to 11 (pitch class)
  scaleId: ScaleId;
  scaleIndex: number; // 0 to 1 for knob mapping
  quantizeEnabled: boolean;
  noImmediateRepeat: boolean;
  avoidLeadingTone: boolean;
  noThirds: boolean;
}

export enum SoundType {
  SYNTH = 'SYNTH',
  SAMPLE = 'SAMPLE'
}

export interface Bubble {
  id: string;
  x: number;
  y: number;
  z: number; // Depth coordinate
  vx: number;
  vy: number;
  vz: number; // Depth velocity
  radius: number; // Base radius
  color: string;
  hue: number;
  charge: number; // 1 (Positive) or -1 (Negative)
  // Amoeba shape properties
  vertices: number[]; // Array of offsets for each vertex
  vertexPhases: number[]; // Random phase for each vertex animation
  deformation: {
    scaleX: number;
    scaleY: number;
    rotation: number;
  };
}

export interface Particle {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    life: number; // 1 to 0
    color: string;
    size: number;
}
