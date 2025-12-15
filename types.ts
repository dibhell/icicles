
export interface AudioSettings {
  volume: number; // 0 to 1
  low: number; // -10 to 10 (dB)
  mid: number; // -10 to 10 (dB)
  high: number; // -10 to 10 (dB)
  reverbWet: number; // 0 to 1
  baseFrequency: number; // Hz
  pingPongWet: number; // 0 to 1
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
  toneMatch: number; // 0 to 1 (Harmonic quantization intensity)
  fragmentation: number; // 0 to 1 (Chance to shatter into particles)
  freeze: number; // 0 to 1 (Viscosity/Freezing effect)
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
