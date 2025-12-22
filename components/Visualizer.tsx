import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Bubble, PhysicsSettings, AudioSettings, Particle, MusicSettings } from '../types';
import { audioService } from '../services/audioEngine';
import { v4 as uuidv4 } from 'uuid';
import { getScaleById } from '../src/music/scales';
import { pitchClassToNoteName } from '../src/music/notes';

interface VisualizerProps {
  isPlaying: boolean;
  physics: PhysicsSettings;
  audioSettings: AudioSettings;
  musicSettings: MusicSettings;
}

export interface VisualizerHandle {
  reset: () => void;
}

// 3D Settings
const DEPTH = 1000;
const FOCAL_LENGTH = 700;
const VERTEX_COUNT = 8;
const FPS_TARGET = 120;
const FPS_OK = FPS_TARGET * 0.5;
const FPS_RECOVER = FPS_TARGET * 0.25;
const FPS_GOOD = FPS_TARGET * 0.9;
const FPS_GUARD_OK = 40;
const FPS_GUARD_RECOVER = 25;
const FPS_GUARD_GOOD = 55;
const FPS_GUARD_RELEASE_MS = 800;

// ---- STABILITY GUARDS (no design change) ----
const EPS = 1e-6;

// Magneto distances (keep your feel, but prevent singularities)
const MAG_MIN_DIST_SQ = 140;     // was 100; a bit safer
const MAG_MAX_DIST_SQ = 150000;  // keep your cutoff

// Caps to prevent velocity runaway on dense clusters
const MAX_SPEED = 22;            // px per tick-ish (tempo-scaled below)
const MAX_ACCEL = 6;             // per frame contribution (tempo-scaled below)

// Audio spam guard (optional but helps when magneto pins on walls)
const AUDIO_COOLDOWN_MS = 50;
const REFLECT_RANGE = 160;
const REFLECT_BACK_RANGE = 220;
const GYRO_MARGIN = 8;
const GYRO_RADIUS_MIN = 22;
const GYRO_RADIUS_MAX = 36;
const GYRO_THICKNESS = 4;
const GYRO_GAP = 5;
const GYRO_HANDLE = 3.5;
const MAGNETO_BOOST = 3.8;
const SHRED_GRACE_MS = 1400;
const SHRED_RECOVERY_DELAY_MS = 1200;
const SHRED_MIN_BUBBLES = 6;
const VOID_PLANE_Z = DEPTH * 0.95; // inner back wall plane for Void sink
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const BUBBLE_COLORS = [
  'hsla(60, 5%, 95%, 1)',   // Snow White
  'hsla(180, 10%, 85%, 1)', // Icy Grey
  'hsla(100, 10%, 80%, 1)', // Pale Moss
  'hsla(200, 15%, 90%, 1)', // Cold Blue
];
type DigitChar = '3' | '6' | '9';
type DigitOverlay = { digit: DigitChar; since: number; until: number };
type GyroRingId = 'pan' | 'depth' | 'width';
const DOT_FONT: Record<string, string[]> = {
  '0': [
    '1111',
    '1001',
    '1001',
    '1001',
    '1001',
    '1001',
    '1111',
  ],
  '1': [
    '0010',
    '0110',
    '0010',
    '0010',
    '0010',
    '0010',
    '0111',
  ],
  '2': [
    '1111',
    '0001',
    '0001',
    '1111',
    '1000',
    '1000',
    '1111',
  ],
  '3': [
    '1111',
    '0001',
    '0001',
    '0111',
    '0001',
    '0001',
    '1111',
  ],
  '4': [
    '1001',
    '1001',
    '1001',
    '1111',
    '0001',
    '0001',
    '0001',
  ],
  '5': [
    '1111',
    '1000',
    '1000',
    '1111',
    '0001',
    '0001',
    '1111',
  ],
  '6': [
    '1111',
    '1000',
    '1000',
    '1111',
    '1001',
    '1001',
    '1111',
  ],
  '7': [
    '1111',
    '0001',
    '0001',
    '0010',
    '0100',
    '0100',
    '0100',
  ],
  '8': [
    '1111',
    '1001',
    '1001',
    '1111',
    '1001',
    '1001',
    '1111',
  ],
  '9': [
    '1111',
    '1001',
    '1001',
    '1111',
    '0001',
    '0001',
    '1111',
  ],
  'S': [
    '01111',
    '10000',
    '10000',
    '01110',
    '00001',
    '00001',
    '11110',
  ],
  'N': [
    '10001',
    '11001',
    '10101',
    '10011',
    '10001',
    '10001',
    '10001',
  ],
  'T': [
    '11111',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
  ],
  'M': [
    '10001',
    '11011',
    '10101',
    '10001',
    '10001',
    '10001',
    '10001',
  ],
  'I': [
    '11111',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
    '11111',
  ],
  'C': [
    '01111',
    '10000',
    '10000',
    '10000',
    '10000',
    '10000',
    '01111',
  ],
  'P': [
    '11110',
    '10001',
    '10001',
    '11110',
    '10000',
    '10000',
    '10000',
  ],
};
const DIGIT_OVERLAY_FADE_MS = 700;
const DIGIT_OVERLAY_MIN_R2D = 14;
const DIGIT_IMPACT_COOLDOWN_MS = 140;
const TESLA_JUMP_PROB = 0.35;
const TESLA_MIN_DIST = 80;
const TESLA_SPARKS = 9;
const PUFF_PARTICLES = 12;
const PUFF_VELOCITY = 6;

type JellyState = {
  sx: number; sy: number; rot: number;
  vsx: number; vsy: number; vrot: number;
  vOff: number[];
  vVel: number[];
  nx2: number; ny2: number;
};

type SourceChoice = { type: 'mic' | 'smp' | 'synth'; index?: number };
const pad2 = (value: number) => String(value).padStart(2, '0');
const getSourceLabel = (source: SourceChoice | null): string => {
  if (!source) return '';
  if (source.type === 'synth') return 'SNT';
  if (source.type === 'mic' && typeof source.index === 'number') return `MIC${pad2(source.index + 1)}`;
  if (source.type === 'smp' && typeof source.index === 'number') return `SMP${pad2(source.index + 1)}`;
  return '';
};
const isSourceValid = (source: SourceChoice | null, bank: { mic: boolean[]; smp: boolean[]; synthEnabled: boolean }) => {
  if (!source) return false;
  if (source.type === 'synth') return bank.synthEnabled;
  if (source.type === 'mic' && typeof source.index === 'number') return Boolean(bank.mic[source.index]);
  if (source.type === 'smp' && typeof source.index === 'number') return Boolean(bank.smp[source.index]);
  return false;
};

type BubbleExt = Bubble & {
  lastAudioAt?: number;
  jelly?: JellyState;
  voidEnteredAt?: number;
  voidGraceMs?: number;
  audioSource?: SourceChoice | null;
  digitOverlay?: DigitOverlay;
  digitImpactsLeft?: number;
  lastDigitImpactAt?: number;
  labelAlpha?: number;
  labelTargetAlpha?: number;
  spawnedAt?: number;
  overlapFrame?: number;
};

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Plane = { n: Vec3; d: number };
type RoomCache = {
  w: number;
  h: number;
  frontBase: Vec3[];
  backBase: Vec3[];
  front: Vec3[];
  back: Vec3[];
  frontProj: Vec2[];
  backProj: Vec2[];
};
type DotTextLayout = {
  glyphs: string[][];
  rows: number;
  colsList: number[];
  totalCols: number;
};

export const Visualizer = forwardRef<VisualizerHandle, VisualizerProps>(
  ({ isPlaying, physics, audioSettings, musicSettings }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const physicsRef = useRef<PhysicsSettings>(physics);
    const audioSettingsRef = useRef<AudioSettings>(audioSettings);
    const musicSettingsRef = useRef<MusicSettings>(musicSettings);
    const bubblesRef = useRef<BubbleExt[]>([]);
    const particlesRef = useRef<Particle[]>([]);
    const requestRef = useRef<number | null>(null);
    const isPlayingRef = useRef<boolean>(isPlaying);
    const fpsRef = useRef({ last: performance.now(), acc: 0, frames: 0, fps: 0 });
    const perfRef = useRef({ recovering: false, lockUntilHighFps: false, recoverAboveMs: 0, shredDelayUntil: 0 });
    const visibilityRef = useRef<boolean>(typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false);
    const grabRef = useRef<{
      id: string | null;
      pointerId: number | null;
      offsetX: number;
      offsetY: number;
      lastX: number;
      lastY: number;
      lastT: number;
    }>({ id: null, pointerId: null, offsetX: 0, offsetY: 0, lastX: 0, lastY: 0, lastT: performance.now() });
    const digitRef = useRef<{ nextAt: number }>({ nextAt: performance.now() + 8000 });
    const gyroStateRef = useRef({ pan: 0, depth: 0, width: 0 });
    const manualGyroRef = useRef({ pan: 0, depth: 0, width: 0 });
    const gyroDragRef = useRef<{ active: boolean; pointerId: number | null; ring: GyroRingId | null }>({
      active: false,
      pointerId: null,
      ring: null,
    });
    const gyroHintRef = useRef({ until: 0 });
    const stereoRef = useRef({ left: 0, right: 0 });
    const gyroTapRef = useRef<{ time: number; ring: GyroRingId | null }>({ time: 0, ring: null });
    const makeGyroAutoChannel = () => {
      const speed = (Math.random() * 0.6 + 0.2) * (Math.random() < 0.5 ? -1 : 1);
      const amp = 0.35 + Math.random() * 0.35;
      const bias = (Math.random() - 0.5) * 0.3;
      return {
        phase: Math.random() * Math.PI * 2,
        speed,
        speedTarget: speed,
        amp,
        ampTarget: amp,
        bias,
        biasTarget: bias,
      };
    };
    const gyroAutoRef = useRef({
      enabled: false,
      blend: 0,
      lastAt: performance.now(),
      nextShiftAt: performance.now() + 3000,
      pan: makeGyroAutoChannel(),
      depth: makeGyroAutoChannel(),
      width: makeGyroAutoChannel(),
    });

    // Matrix Log Buffer
    const logRef = useRef<string[]>([]);
    const particlePoolRef = useRef<Particle[]>([]);
    const bubblePoolRef = useRef<BubbleExt[]>([]);
    const frameIdRef = useRef(0);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const backgroundRef = useRef<{ canvas: HTMLCanvasElement | null; w: number; h: number }>({
      canvas: null,
      w: 0,
      h: 0,
    });
    const voidCacheRef = useRef<{ canvas: HTMLCanvasElement | null; w: number; h: number; strength: number }>({
      canvas: null,
      w: 0,
      h: 0,
      strength: -1,
    });
    const roomCacheRef = useRef<RoomCache | null>(null);
    const dotTextCacheRef = useRef<Map<string, DotTextLayout>>(new Map());
    const amoebaPointsRef = useRef<Vec2[]>(
      Array.from({ length: VERTEX_COUNT }, () => ({ x: 0, y: 0 }))
    );
    const topPairsRef = useRef<{ b1: BubbleExt | null; b2: BubbleExt | null; dist: number }[]>([
      { b1: null, b2: null, dist: Infinity },
      { b1: null, b2: null, dist: Infinity },
      { b1: null, b2: null, dist: Infinity },
    ]);

    // Drawing State
    const isDrawingRef = useRef(false);
    const lastSpawnPos = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => { physicsRef.current = physics; }, [physics]);
    useEffect(() => { audioSettingsRef.current = audioSettings; }, [audioSettings]);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
    useEffect(() => { musicSettingsRef.current = musicSettings; }, [musicSettings]);
    useEffect(() => {
      const onVis = () => { visibilityRef.current = document.visibilityState === 'hidden'; };
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    useImperativeHandle(ref, () => ({
      reset: () => {
        bubblesRef.current.forEach(releaseBubble);
        particlesRef.current.forEach(releaseParticle);
        bubblesRef.current = [];
        particlesRef.current = [];
        logRef.current = [];
        gyroStateRef.current = { pan: 0, depth: 0, width: 0 };
        manualGyroRef.current = { pan: 0, depth: 0, width: 0 };
        gyroAutoRef.current.enabled = false;
        gyroAutoRef.current.blend = 0;
        gyroHintRef.current.until = 0;
        frameIdRef.current = 0;
        audioService.setSpatialControl(0, 0, 0);
      },
    }));

    const pushLog = (msg: string) => {
      const ts = new Date().toISOString().split('T')[1].split('.')[0];
      const line = `[${ts}] ${msg}`;
      logRef.current.push(line);
      if (logRef.current.length > 16) logRef.current.shift();
    };

    const resetCachesForSize = () => {
      backgroundRef.current.w = 0;
      backgroundRef.current.h = 0;
      voidCacheRef.current.w = 0;
      voidCacheRef.current.h = 0;
      roomCacheRef.current = null;
    };

    const getCanvasContext = (canvas: HTMLCanvasElement) => {
      let ctx = ctxRef.current;
      if (!ctx || ctx.canvas !== canvas) {
        ctx = canvas.getContext('2d', { alpha: false });
        ctxRef.current = ctx;
      }
      return ctx;
    };

    const ensureBackground = (w: number, h: number) => {
      const cache = backgroundRef.current;
      if (!cache.canvas && typeof document !== 'undefined') {
        cache.canvas = document.createElement('canvas');
      }
      if (!cache.canvas) return null;
      if (cache.w !== w || cache.h !== h) {
        cache.canvas.width = w;
        cache.canvas.height = h;
        const bctx = cache.canvas.getContext('2d', { alpha: false });
        if (!bctx) return null;
        bctx.clearRect(0, 0, w, h);
        bctx.fillStyle = '#2E2F2B';
        bctx.fillRect(0, 0, w, h);
        const gradientBack = bctx.createLinearGradient(0, 0, 0, h);
        gradientBack.addColorStop(0, '#2E2F2B');
        gradientBack.addColorStop(1, '#3F453F');
        bctx.fillStyle = gradientBack;
        bctx.fillRect(0, 0, w, h);
        cache.w = w;
        cache.h = h;
      }
      return cache.canvas;
    };

    const ensureVoidGradient = (w: number, h: number, strength: number) => {
      if (strength <= 0.02) return null;
      const cache = voidCacheRef.current;
      if (!cache.canvas && typeof document !== 'undefined') {
        cache.canvas = document.createElement('canvas');
      }
      if (!cache.canvas) return null;
      if (cache.w !== w || cache.h !== h || cache.strength !== strength) {
        cache.canvas.width = w;
        cache.canvas.height = h;
        const vctx = cache.canvas.getContext('2d');
        if (!vctx) return null;
        vctx.clearRect(0, 0, w, h);
        const cx = w / 2;
        const cy = h / 2;
        const core = 18 + strength * 70;
        const halo = core * 2.6;
        vctx.save();
        vctx.translate(cx, cy);
        vctx.globalCompositeOperation = 'source-over';
        const grad = vctx.createRadialGradient(0, 0, 0, 0, 0, halo);
        grad.addColorStop(0, 'rgba(8,8,8,0.92)');
        grad.addColorStop(0.35, 'rgba(20,20,20,0.55)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        vctx.fillStyle = grad;
        vctx.beginPath();
        vctx.arc(0, 0, halo, 0, Math.PI * 2);
        vctx.fill();
        vctx.restore();
        cache.w = w;
        cache.h = h;
        cache.strength = strength;
      }
      return cache.canvas;
    };

    const ensureRoomCache = (w: number, h: number): RoomCache => {
      let cache = roomCacheRef.current;
      if (!cache || cache.w !== w || cache.h !== h) {
        const frontBase = [
          { x: 0, y: 0, z: 0 },
          { x: w, y: 0, z: 0 },
          { x: w, y: h, z: 0 },
          { x: 0, y: h, z: 0 },
        ];
        const backBase = [
          { x: -w * 0.1, y: -h * 0.1, z: DEPTH },
          { x: w * 1.2, y: -h * 0.05, z: DEPTH * 0.9 },
          { x: w * 0.9, y: h * 1.1, z: DEPTH },
          { x: -w * 0.05, y: h * 1.05, z: DEPTH * 1.1 },
        ];
        const front = frontBase.map(p => ({ ...p }));
        const back = backBase.map(p => ({ ...p }));
        const frontProj = frontBase.map(() => ({ x: 0, y: 0 }));
        const backProj = backBase.map(() => ({ x: 0, y: 0 }));
        cache = { w, h, frontBase, backBase, front, back, frontProj, backProj };
        roomCacheRef.current = cache;
      }
      return cache;
    };

    const updateRoomWarp = (w: number, h: number, warp: number, wave: number, time: number) => {
      const cache = ensureRoomCache(w, h);
      const { frontBase, backBase, front, back } = cache;
      for (let i = 0; i < front.length; i++) {
        front[i].x = frontBase[i].x;
        front[i].y = frontBase[i].y;
        front[i].z = frontBase[i].z;
        back[i].x = backBase[i].x;
        back[i].y = backBase[i].y;
        back[i].z = backBase[i].z;
      }

      const warpAmt = warp * 0.35;
      const waveScale = wave * 0.35;
      const waveAmt = waveScale * 0.25;
      const wavePhase = time * 0.6;

      const warpOffset = (ix: number, iy: number, iz: number, out: Vec3) => {
        const dx = (Math.sin(wavePhase + ix * 0.5 + iy * 0.3) + 1) * 0.5;
        const dy = (Math.cos(wavePhase * 0.7 + ix * 0.2 + iy * 0.6) + 1) * 0.5;
        out.x = (dx - 0.5) * warpAmt * w;
        out.y = (dy - 0.5) * warpAmt * h;
        out.z = (Math.sin(wavePhase + iz) + 1) * 0.5 * warpAmt * DEPTH * 0.3;
      };

      const fTL = front[0];
      const fTR = front[1];
      const fBR = front[2];
      const fBL = front[3];

      const bTL = back[0];
      const bTR = back[1];
      const bBR = back[2];
      const bBL = back[3];

      [fTL, fTR, fBR, fBL].forEach((p, idx) => {
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.6) : 0;
        p.x += (idx === 0 ? -1 : idx === 1 ? 1 : 0) * warpAmt * w * 0.2;
        p.y += (idx === 0 ? -1 : idx === 3 ? 1 : 0) * warpAmt * h * 0.15;
        p.z += wv * DEPTH * 0.1;
      });
      const offs: Vec3 = { x: 0, y: 0, z: 0 };
      [bTL, bTR, bBR, bBL].forEach((p, idx) => {
        warpOffset(idx, idx * 0.3, idx * 0.5, offs);
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.8 + 1.2) : 0;
        p.x += offs.x;
        p.y += offs.y;
        p.z += offs.z + wv * DEPTH * 0.2;
      });

      return cache;
    };

    const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
    const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    });
    const normalize3 = (v: Vec3): Vec3 => {
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
      return { x: v.x / len, y: v.y / len, z: v.z / len };
    };
    const planeFromPoints = (a: Vec3, b: Vec3, c: Vec3, inside: Vec3): Plane => {
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      let n = normalize3(cross3(ab, ac));
      let d = -dot3(n, a);
      if (dot3(n, inside) + d < 0) {
        n = { x: -n.x, y: -n.y, z: -n.z };
        d = -d;
      }
      return { n, d };
    };
    const planeDistance = (plane: Plane, p: Vec3) => dot3(plane.n, p) + plane.d;
    const reflectAcrossPlane = (p: Vec3, plane: Plane): Vec3 => {
      const dist = planeDistance(plane, p);
      return {
        x: p.x - 2 * dist * plane.n.x,
        y: p.y - 2 * dist * plane.n.y,
        z: p.z - 2 * dist * plane.n.z,
      };
    };

    const getDotTextLayout = (text: string): DotTextLayout | null => {
      if (!text) return null;
      const cache = dotTextCacheRef.current;
      const cached = cache.get(text);
      if (cached) return cached;
      const glyphs = text.split('').map(ch => DOT_FONT[ch]).filter(Boolean);
      if (!glyphs.length) return null;
      const rows = glyphs[0].length;
      const colsList = glyphs.map(g => g[0]?.length ?? 0);
      const gapCols = 1;
      const totalCols = colsList.reduce((sum, v) => sum + v, 0) + gapCols * Math.max(0, glyphs.length - 1);
      const layout = { glyphs, rows, colsList, totalCols };
      cache.set(text, layout);
      return layout;
    };

    const acquireParticle = () => {
      return particlePoolRef.current.pop() || {
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0,
        color: '',
        size: 0,
      };
    };

    const releaseParticle = (p: Particle) => {
      particlePoolRef.current.push(p);
    };

    const resetJelly = (jelly: JellyState) => {
      jelly.sx = 1; jelly.sy = 1; jelly.rot = 0;
      jelly.vsx = 0; jelly.vsy = 0; jelly.vrot = 0;
      jelly.nx2 = 1; jelly.ny2 = 0;
      if (jelly.vOff.length !== VERTEX_COUNT) jelly.vOff = new Array(VERTEX_COUNT).fill(0);
      if (jelly.vVel.length !== VERTEX_COUNT) jelly.vVel = new Array(VERTEX_COUNT).fill(0);
      for (let i = 0; i < VERTEX_COUNT; i++) {
        jelly.vOff[i] = 0;
        jelly.vVel[i] = 0;
      }
    };

    const acquireBubble = (): BubbleExt => {
      const b = bubblePoolRef.current.pop();
      if (b) return b;
      return {
        id: '',
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        radius: 0,
        color: '',
        hue: 0,
        charge: 1,
        vertices: new Array(VERTEX_COUNT).fill(1),
        vertexPhases: new Array(VERTEX_COUNT).fill(0),
        deformation: { scaleX: 1, scaleY: 1, rotation: 0 },
      };
    };

    const releaseBubble = (b: BubbleExt) => {
      b.audioSource = null;
      b.digitOverlay = undefined;
      b.digitImpactsLeft = undefined;
      b.lastDigitImpactAt = undefined;
      b.voidEnteredAt = undefined;
      b.voidGraceMs = undefined;
      b.labelAlpha = undefined;
      b.labelTargetAlpha = undefined;
      b.spawnedAt = undefined;
      b.overlapFrame = undefined;
      bubblePoolRef.current.push(b);
    };

    const removeBubbleAt = (bubbles: BubbleExt[], index: number) => {
      const removed = bubbles[index];
      const last = bubbles.pop();
      if (last && last !== removed) {
        bubbles[index] = last;
        releaseBubble(removed);
        return true;
      }
      if (removed) releaseBubble(removed);
      return false;
    };

    const clampSigned = (v: number) => Math.max(-1, Math.min(1, v));
    const valueToAngle = (v: number) => clampSigned(v) * Math.PI;
    const angleToValue = (ang: number) => clampSigned(ang / Math.PI);

    const getGyroLayout = (w: number, h: number) => {
      const base = Math.max(GYRO_RADIUS_MIN, Math.min(GYRO_RADIUS_MAX, Math.min(w, h) * 0.07));
      const r0 = base;
      const r1 = r0 + GYRO_THICKNESS + GYRO_GAP;
      const r2 = r1 + GYRO_THICKNESS + GYRO_GAP;
      const outer = r2 + GYRO_THICKNESS;
      const cx = GYRO_MARGIN + outer;
      const cy = GYRO_MARGIN + outer;
      const rings: { id: GyroRingId; r: number }[] = [
        { id: 'pan', r: r0 },
        { id: 'depth', r: r1 },
        { id: 'width', r: r2 },
      ];
      return { cx, cy, rings, outer };
    };

    const getGyroAutoLayout = (layout: ReturnType<typeof getGyroLayout>) => {
      const innerR = Math.max(8, layout.rings[0].r - GYRO_THICKNESS * 1.4);
      const circleR = Math.max(6, innerR * 0.42);
      const circleGap = circleR * 0.7;
      const autoR = Math.max(4.5, circleR * 0.55) + 2;
      const autoY = circleR + circleGap * 0.6 + autoR - 4;
      return { innerR, circleR, circleGap, autoR, autoY };
    };

    const hitTestGyro = (x: number, y: number, layout: ReturnType<typeof getGyroLayout>) => {
      const dx = x - layout.cx;
      const dy = y - layout.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let hit: GyroRingId | null = null;
      let best = Infinity;
      layout.rings.forEach((ring) => {
        const diff = Math.abs(dist - ring.r);
        if (diff <= GYRO_THICKNESS * 1.4 && diff < best) {
          best = diff;
          hit = ring.id;
        }
      });
      if (!hit) return null;
      const angle = Math.atan2(dy, dx);
      return { ring: hit, value: angleToValue(angle) };
    };

    const applyGyroOutput = (next: { pan: number; depth: number; width: number }) => {
      gyroStateRef.current = next;
      audioService.setSpatialControl(next.pan, next.depth, next.width);
    };

    const updateGyroAuto = (nowMs: number) => {
      const auto = gyroAutoRef.current;
      const dt = Math.min(0.05, Math.max(0, (nowMs - auto.lastAt) / 1000));
      auto.lastAt = nowMs;
      if (dt <= 0) return;

      const targetBlend = auto.enabled ? 1 : 0;
      auto.blend += (targetBlend - auto.blend) * Math.min(1, dt * 0.6);
      auto.blend = clamp01(auto.blend);

      const shouldShift = auto.enabled && nowMs >= auto.nextShiftAt;
      if (shouldShift) {
        const retarget = (ch: typeof auto.pan) => {
          ch.speedTarget = (Math.random() * 0.9 + 0.15) * (Math.random() < 0.5 ? -1 : 1);
          ch.ampTarget = 0.25 + Math.random() * 0.65;
          ch.biasTarget = (Math.random() - 0.5) * 0.35;
        };
        retarget(auto.pan);
        retarget(auto.depth);
        retarget(auto.width);
        auto.nextShiftAt = nowMs + 4500 + Math.random() * 7000;
      }

      const step = (ch: typeof auto.pan) => {
        ch.speed += (ch.speedTarget - ch.speed) * dt * 0.6;
        ch.amp += (ch.ampTarget - ch.amp) * dt * 0.4;
        ch.bias += (ch.biasTarget - ch.bias) * dt * 0.3;
        ch.phase += ch.speed * dt;
      };

      if (!auto.enabled && auto.blend <= 0.01) return;
      step(auto.pan);
      step(auto.depth);
      step(auto.width);

      const autoPan = clampSigned(auto.pan.bias + Math.sin(auto.pan.phase) * auto.pan.amp);
      const autoDepth = clampSigned(auto.depth.bias + Math.sin(auto.depth.phase) * auto.depth.amp);
      const autoWidth = clampSigned(auto.width.bias + Math.sin(auto.width.phase) * auto.width.amp);

      const manual = manualGyroRef.current;
      const blend = auto.blend;
      const next = {
        pan: manual.pan + (autoPan - manual.pan) * blend,
        depth: manual.depth + (autoDepth - manual.depth) * blend,
        width: manual.width + (autoWidth - manual.width) * blend,
      };
      applyGyroOutput(next);
    };

    const setManualGyro = (ring: GyroRingId, value: number) => {
      const next = { ...manualGyroRef.current };
      if (ring === 'pan') next.pan = clampSigned(value);
      if (ring === 'depth') next.depth = clampSigned(value);
      if (ring === 'width') next.width = clampSigned(value);
      manualGyroRef.current = next;
      if (!gyroAutoRef.current.enabled && gyroAutoRef.current.blend < 0.02) {
        applyGyroOutput(next);
      }
      gyroHintRef.current.until = performance.now() + 1400;
    };

    const toggleGyroAuto = () => {
      const auto = gyroAutoRef.current;
      const wasEnabled = auto.enabled;
      auto.enabled = !auto.enabled;
      auto.lastAt = performance.now();
      auto.nextShiftAt = auto.lastAt + 2000 + Math.random() * 5000;
      if (wasEnabled) {
        manualGyroRef.current = { ...gyroStateRef.current };
      }
      gyroHintRef.current.until = performance.now() + 1400;
    };

    const applyJellyImpact = (b: BubbleExt, nx: number, ny: number, impulse: number) => {
      if (!b.jelly) return;
      let nl = Math.sqrt(nx * nx + ny * ny);
      if (nl < EPS) nl = 1;
      nx /= nl; ny /= nl;

      const k = Math.min(1, Math.max(0, impulse / 18)) * (50 / Math.max(18, b.radius));
      const squash = 1 - 0.28 * k;
      const stretch = 1 + 0.18 * k;
      const targetRot = Math.atan2(ny, nx);

      b.jelly.nx2 = nx; b.jelly.ny2 = ny;
      b.jelly.vsx += (squash - b.jelly.sx) * 0.9;
      b.jelly.vsy += (stretch - b.jelly.sy) * 0.9;
      b.jelly.vrot += (targetRot - b.jelly.rot) * 0.25;

      const step = (Math.PI * 2) / VERTEX_COUNT;
      for (let i = 0; i < VERTEX_COUNT; i++) {
        const a = i * step;
        const vx = Math.cos(a);
        const vy = Math.sin(a);
        const d = vx * nx + vy * ny;
        const push = (-0.22 * k) * Math.max(0, d) + (0.10 * k) * Math.max(0, -d);
        b.jelly.vVel[i] += push * 3.2;
      }
    };

    const updateJelly = (b: BubbleExt, tempo: number) => {
      if (!b.jelly) return;
      const SPR = 0.18 * tempo;
      const DMP = 0.78;
      const ROT_SPR = 0.10 * tempo;
      const ROT_DMP = 0.80;

      const ax = (1 - b.jelly.sx) * SPR;
      const ay = (1 - b.jelly.sy) * SPR;
      b.jelly.vsx = (b.jelly.vsx + ax) * DMP;
      b.jelly.vsy = (b.jelly.vsy + ay) * DMP;
      b.jelly.sx += b.jelly.vsx;
      b.jelly.sy += b.jelly.vsy;

      const arot = (0 - b.jelly.rot) * ROT_SPR;
      b.jelly.vrot = (b.jelly.vrot + arot) * ROT_DMP;
      b.jelly.rot += b.jelly.vrot;

      b.jelly.sx = Math.max(0.7, Math.min(1.3, b.jelly.sx));
      b.jelly.sy = Math.max(0.7, Math.min(1.3, b.jelly.sy));

      const VSPR = 0.22 * tempo;
      const VDMP = 0.70;
      for (let i = 0; i < VERTEX_COUNT; i++) {
        const a = (0 - b.jelly.vOff[i]) * VSPR;
        b.jelly.vVel[i] = (b.jelly.vVel[i] + a) * VDMP;
        b.jelly.vOff[i] += b.jelly.vVel[i];
        b.jelly.vOff[i] = Math.max(-0.35, Math.min(0.35, b.jelly.vOff[i]));
      }

      b.deformation.scaleX = b.jelly.sx;
      b.deformation.scaleY = b.jelly.sy;
      b.deformation.rotation = b.jelly.rot;
    };

    const spawnParticle = (x: number, y: number, z: number, color: string) => {
      const p = acquireParticle();
      p.x = x; p.y = y; p.z = z;
      p.vx = (Math.random() - 0.5) * 15;
      p.vy = (Math.random() - 0.5) * 15;
      p.vz = (Math.random() - 0.5) * 15;
      p.life = 1.0;
      p.color = color;
      p.size = Math.random() * 2 + 0.5;
      particlesRef.current.push(p);
    };

    const spawnPuff = (b: BubbleExt) => {
      for (let i = 0; i < PUFF_PARTICLES; i++) {
        const p = acquireParticle();
        p.x = b.x;
        p.y = b.y;
        p.z = b.z;
        p.vx = (Math.random() - 0.5) * PUFF_VELOCITY;
        p.vy = (Math.random() - 0.5) * PUFF_VELOCITY;
        p.vz = (Math.random() - 0.5) * (PUFF_VELOCITY * 0.6);
        p.life = 0.6;
        p.color = b.color;
        p.size = Math.random() * 1.6 + 0.4;
        particlesRef.current.push(p);
      }
    };

    const spawnBubble = (x: number, y: number, z: number = 0, r?: number) => {
      const color = BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)];
      const radius = r || Math.random() * 35 + 15;
      const b = acquireBubble();
      const vertices = b.vertices.length === VERTEX_COUNT ? b.vertices : new Array(VERTEX_COUNT).fill(1);
      const vertexPhases = b.vertexPhases.length === VERTEX_COUNT ? b.vertexPhases : new Array(VERTEX_COUNT).fill(0);
      for (let i = 0; i < VERTEX_COUNT; i++) {
        vertices[i] = 1;
        vertexPhases[i] = Math.random() * Math.PI * 2;
      }
      b.vertices = vertices;
      b.vertexPhases = vertexPhases;
      const jelly = b.jelly ?? {
        sx: 1, sy: 1, rot: 0,
        vsx: 0, vsy: 0, vrot: 0,
        vOff: new Array(VERTEX_COUNT).fill(0),
        vVel: new Array(VERTEX_COUNT).fill(0),
        nx2: 1, ny2: 0,
      };
      resetJelly(jelly);
      const charge = Math.random() > 0.5 ? 1 : -1;
      const id = uuidv4().substring(0, 6).toUpperCase();

      const audioSource = audioService.assignSourceToBubble();
      const hasLabel = Boolean(audioSource);
      const spawnedAt = performance.now();
      b.id = id;
      b.x = x;
      b.y = y;
      b.z = z || Math.random() * (DEPTH * 0.5);
      b.vx = (Math.random() - 0.5) * 2;
      b.vy = (Math.random() - 0.5) * 2;
      b.vz = (Math.random() - 0.5) * 2;
      b.radius = radius;
      b.color = color;
      b.hue = 0;
      b.charge = charge;
      if (!b.deformation) b.deformation = { scaleX: 1, scaleY: 1, rotation: 0 };
      b.deformation.scaleX = 1;
      b.deformation.scaleY = 1;
      b.deformation.rotation = 0;
      b.jelly = jelly;
      b.lastAudioAt = 0;
      b.audioSource = audioSource;
      b.digitOverlay = undefined;
      b.digitImpactsLeft = undefined;
      b.lastDigitImpactAt = undefined;
      b.voidEnteredAt = undefined;
      b.voidGraceMs = undefined;
      b.overlapFrame = undefined;
      b.labelAlpha = hasLabel ? 0.6 : 0;
      b.labelTargetAlpha = hasLabel ? 0.6 : 0;
      b.spawnedAt = spawnedAt;
      bubblesRef.current.push(b);

      pushLog(`SPAWN: ${id} <R:${Math.round(radius)}>`);
    };

    const assignDigitOverlay = (digit: DigitChar, nowMs: number) => {
      const bubbles = bubblesRef.current;
      if (!bubbles.length) return;
      if (bubbles.some((b) => b.digitOverlay)) return;

      const candidates = bubbles.filter((b) => {
        if (b.digitOverlay) return false;
        const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
        return b.radius * scale >= DIGIT_OVERLAY_MIN_R2D;
      });
      if (!candidates.length) return;

      candidates.sort((a, b) => b.radius - a.radius);
      const slice = Math.max(1, Math.floor(candidates.length * 0.35));
      const pick = candidates[Math.floor(Math.random() * slice)];
      const impacts = parseInt(digit, 10);
      pick.digitOverlay = {
        digit,
        since: nowMs,
        until: Number.POSITIVE_INFINITY,
      };
      pick.digitImpactsLeft = Number.isFinite(impacts) ? impacts : undefined;
      pick.lastDigitImpactAt = undefined;
    };

    const registerDigitImpact = (b: BubbleExt, nowMs: number) => {
      if (!b.digitOverlay || !b.digitImpactsLeft) return;
      if (b.lastDigitImpactAt && (nowMs - b.lastDigitImpactAt) < DIGIT_IMPACT_COOLDOWN_MS) return;
      b.lastDigitImpactAt = nowMs;
      b.digitImpactsLeft -= 1;
      if (b.digitImpactsLeft <= 0) return;
      if (Math.random() < TESLA_JUMP_PROB) teslaJump(b, nowMs);
    };

    const spawnTeslaArc = (from: BubbleExt, to: BubbleExt) => {
      const sparks = TESLA_SPARKS;
      for (let i = 0; i < sparks; i++) {
        const t = sparks <= 1 ? 0.5 : i / (sparks - 1);
        const jitter = 10;
        const x = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * jitter;
        const y = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * jitter;
        const z = from.z + (to.z - from.z) * t + (Math.random() - 0.5) * jitter * 0.6;
        spawnParticle(x, y, z, 'rgba(190, 220, 255, 0.95)');
      }
    };

    const teslaJump = (from: BubbleExt, nowMs: number) => {
      const bubbles = bubblesRef.current;
      const overlay = from.digitOverlay;
      if (!overlay) return;
      const candidates = bubbles.filter((b) => {
        if (b === from) return false;
        if (b.digitOverlay) return false;
        const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
        if (b.radius * scale < DIGIT_OVERLAY_MIN_R2D) return false;
        const dx = b.x - from.x;
        const dy = b.y - from.y;
        const dz = b.z - from.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        return distSq >= TESLA_MIN_DIST * TESLA_MIN_DIST;
      });
      if (!candidates.length) return;
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      spawnTeslaArc(from, target);
      const impactsLeft = from.digitImpactsLeft;
      from.digitOverlay = undefined;
      from.digitImpactsLeft = undefined;
      from.lastDigitImpactAt = undefined;
      target.digitOverlay = { ...overlay, since: nowMs, until: Number.POSITIVE_INFINITY };
      target.digitImpactsLeft = impactsLeft;
      target.lastDigitImpactAt = nowMs;
    };

    const project2D = (b: BubbleExt, w: number, h: number) => {
      const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
      const cx = w / 2; const cy = h / 2;
      return {
        x: (b.x - cx) * scale + cx,
        y: (b.y - cy) * scale + cy,
        r: b.radius * scale,
        scale,
      };
    };

    const screenToWorld = (sx: number, sy: number, z: number, w: number, h: number) => {
      const cx = w / 2; const cy = h / 2;
      const scale = FOCAL_LENGTH / (FOCAL_LENGTH + z);
      return {
        x: ((sx - cx) / scale) + cx,
        y: ((sy - cy) / scale) + cy,
      };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
      if (!containerRef.current || !canvasRef.current) return;
      e.preventDefault();
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gyroLayout = getGyroLayout(canvasRef.current.width, canvasRef.current.height);
      const autoLayout = getGyroAutoLayout(gyroLayout);
      const autoDx = x - gyroLayout.cx;
      const autoDy = y - (gyroLayout.cy + autoLayout.autoY);
      if ((autoDx * autoDx + autoDy * autoDy) <= (autoLayout.autoR * autoLayout.autoR)) {
        toggleGyroAuto();
        return;
      }
      const gyroHit = hitTestGyro(x, y, gyroLayout);
      if (gyroHit) {
        const nowMs = performance.now();
        if (gyroTapRef.current.ring === gyroHit.ring && (nowMs - gyroTapRef.current.time) < 280) {
          gyroTapRef.current = { time: 0, ring: null };
          setManualGyro(gyroHit.ring, 0);
          return;
        }
        gyroTapRef.current = { time: nowMs, ring: gyroHit.ring };
        gyroDragRef.current = { active: true, pointerId: e.pointerId, ring: gyroHit.ring };
        setManualGyro(gyroHit.ring, gyroHit.value);
        try { canvasRef.current.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }

      // hit test bubbles (topmost)
      const bubbles = bubblesRef.current;
      let hit: BubbleExt | null = null;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const p = project2D(bubbles[i], canvasRef.current.width, canvasRef.current.height);
        const dx = x - p.x; const dy = y - p.y;
        if (dx * dx + dy * dy <= p.r * p.r) { hit = bubbles[i]; break; }
      }

      if (hit) {
        grabRef.current = {
          id: hit.id,
          pointerId: e.pointerId,
          offsetX: x - project2D(hit, canvasRef.current.width, canvasRef.current.height).x,
          offsetY: y - project2D(hit, canvasRef.current.width, canvasRef.current.height).y,
          lastX: x,
          lastY: y,
          lastT: performance.now(),
        };
        isDrawingRef.current = false;
        lastSpawnPos.current = null;
        try { canvasRef.current.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }

      isDrawingRef.current = true;
      lastSpawnPos.current = { x, y };
      spawnBubble(x, y, 50);
      // no pointer capture needed for spawn-only
    };

    const handlePointerMove = (e: React.PointerEvent) => {
      if (!containerRef.current || !canvasRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gyroLayout = getGyroLayout(canvasRef.current.width, canvasRef.current.height);

      if (gyroDragRef.current.active && gyroDragRef.current.pointerId === e.pointerId) {
        const ring = gyroDragRef.current.ring;
        if (ring) {
          const angle = Math.atan2(y - gyroLayout.cy, x - gyroLayout.cx);
          setManualGyro(ring, angleToValue(angle));
        }
        return;
      }

      // dragging existing bubble
      if (grabRef.current.id && grabRef.current.pointerId === e.pointerId) {
        const b = bubblesRef.current.find(bb => bb.id === grabRef.current.id);
        if (b) {
          const { offsetX, offsetY, lastX, lastY, lastT } = grabRef.current;
          const now = performance.now();
          const dt = Math.max(1, now - lastT);
          const prevPos = { x: lastX, y: lastY };
          grabRef.current.lastX = x;
          grabRef.current.lastY = y;
          grabRef.current.lastT = now;

          const world = screenToWorld(x - offsetX, y - offsetY, b.z, canvasRef.current.width, canvasRef.current.height);
          b.x = world.x;
          b.y = world.y;

          const vx = (x - prevPos.x) / dt * 16;
          const vy = (y - prevPos.y) / dt * 16;
          b.vx = vx;
          b.vy = vy;

          const speed = Math.sqrt(vx * vx + vy * vy);
          if (speed > 0.1) {
            const nx = vx / (speed || 1);
            const ny = vy / (speed || 1);
            applyJellyImpact(b, nx, ny, speed * 0.6);
            if (b.jelly) {
              b.jelly.rot = 0;
              b.jelly.vrot = 0;
              b.deformation.rotation = 0;
            }
          }
        }
        return;
      }

      // spawn-draw mode
      if (!isDrawingRef.current || !containerRef.current) return;
      if (lastSpawnPos.current) {
        const dx = x - lastSpawnPos.current.x;
        const dy = y - lastSpawnPos.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 50) {
          spawnBubble(x, y, 50 + Math.random() * 100);
          lastSpawnPos.current = { x, y };
        }
      }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
      if (!canvasRef.current) return;
      if (gyroDragRef.current.active && gyroDragRef.current.pointerId === e.pointerId) {
        gyroDragRef.current = { active: false, pointerId: null, ring: null };
        try { canvasRef.current.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      if (grabRef.current.id && grabRef.current.pointerId === e.pointerId) {
        grabRef.current = { id: null, pointerId: null, offsetX: 0, offsetY: 0, lastX: 0, lastY: 0, lastT: performance.now() };
      }
      isDrawingRef.current = false;
      lastSpawnPos.current = null;
      try { canvasRef.current.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    const triggerBubbleSound = (b: BubbleExt, triggerType: string) => {
      const now = performance.now();
      if (b.lastAudioAt && (now - b.lastAudioAt) < AUDIO_COOLDOWN_MS) return;
      b.lastAudioAt = now;

      const phys = physicsRef.current;
      const audio = audioSettingsRef.current;
      const isReverse = Math.random() < phys.reverseChance;

      const sizeVol = Math.min(1, Math.max(0.2, b.radius / 70));
      const distanceFactor = Math.max(0, 1 - (b.z / (DEPTH * 1.5)));
      const finalVol = sizeVol * distanceFactor;

      const width = (canvasRef.current && canvasRef.current.width > 0) ? canvasRef.current.width : 1000;
      const pan = (b.x / width) * 2 - 1;
      const depth = Math.min(1, Math.max(0, b.z / DEPTH));

      audioService.triggerSound(
        1 - (b.radius / 180),
        audio.baseFrequency,
        pan, depth, b.vz,
        phys.doppler, isReverse, finalVol,
        musicSettingsRef.current,
        undefined,
        b.audioSource
      );

      if (Math.random() > 0.85) {
        pushLog(`AUDIO: ${triggerType} [${b.id}]`);
      }
    };

    // --- DRAWING FUNCTIONS ---

    const drawMatrixLog = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      metrics: { peakDb: number; baseFreq: number; objects: number; fps: number }
    ) => {
      ctx.save();
      ctx.font = '8px "Courier New", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      // Log Entries
      let y = h - 20;
      const total = logRef.current.length;
      const alphaMax = 0.9;
      const alphaMin = 0.05;
      for (let i = logRef.current.length - 1; i >= 0; i--) {
        const idxFromBottom = logRef.current.length - 1 - i;
        const t = total > 1 ? idxFromBottom / (total - 1) : 0;
        const alpha = alphaMax - (alphaMax - alphaMin) * t;
        ctx.fillStyle = `rgba(200, 210, 205, ${alpha.toFixed(3)})`;
        ctx.fillText(logRef.current[i], 15, y);
        y -= 12;
      }

      // System Params (Top Right)
      const phys = physicsRef.current;
      const audio = audioSettingsRef.current;

      const music = musicSettingsRef.current;
      const scale = getScaleById(music.scaleId);
      const rootName = pitchClassToNoteName(music.root);
      let scaleLabel = `${rootName} ${scale.label.toUpperCase()}`;
      if (music.noThirds || scale.tags?.includes('no3rd')) scaleLabel += ' NO-3RD';
      if (scale.tags?.includes('drone')) scaleLabel += ' DRONE';

      const poolInfo = audioService.getActivePoolInfo();
      const poolLabel = poolInfo.labels.length ? poolInfo.labels.join('|') : '--';
      const eqLow = Number.isFinite(audio.low) ? audio.low : 0;
      const eqMid = Number.isFinite(audio.mid) ? audio.mid : 0;
      const eqHigh = Number.isFinite(audio.high) ? audio.high : 0;
      const params = [
        `// PLAY_POOL`,
        `PLAY_CNT  : ${poolInfo.size}`,
        `PLAY_SET  : ${poolLabel}`,
        `// CORE_PHYSICS`,
        `CLK_TEMPO : ${phys.tempo.toFixed(2)}`,
        `G_FORCE   : ${phys.gravity.toFixed(2)}`,
        `WIND_VEC  : ${phys.wind.toFixed(2)}`,
        `VISCOSITY : ${phys.freeze.toFixed(2)}`,
        `// INTERACTION`,
        `MAG_FIELD : ${phys.magneto.toFixed(2)}`,
        `SINGULRTY : ${phys.blackHole.toFixed(2)}`,
        `DOPPLER   : ${phys.doppler.toFixed(2)}`,
        `// BIOLOGY`,
        `MITOSIS   : ${phys.buddingChance.toFixed(3)}`,
        `FUSION    : ${phys.cannibalism.toFixed(2)}`,
        `DECAY     : ${phys.weakness.toFixed(2)}`,
        `ENTROPY   : ${phys.fragmentation.toFixed(3)}`,
        `// AUDIO_DSP`,
        `FREQ_OSC  : ${Math.round(audio.baseFrequency)}Hz`,
        `EQ_LOW    : ${eqLow.toFixed(1)}dB`,
        `EQ_MID    : ${eqMid.toFixed(1)}dB`,
        `EQ_HIGH   : ${eqHigh.toFixed(1)}dB`,
        `PEAK_DB   : ${metrics.peakDb.toFixed(1)}dB`,
        `SCALE_MODE: ${scaleLabel}`,
        `VERB_MIX  : ${audio.reverbWet.toFixed(2)}`,
        `ECHO_FDBK : ${phys.pingPong.toFixed(2)}`,
        `REV_PROB  : ${phys.reverseChance.toFixed(2)}`,
        `// SYSTEM`,
        `ACTIVE_OBJ: ${metrics.objects}`,
        `HEAP_SIZE : ${(metrics.objects * 0.45).toFixed(2)}KB`,
        `FPS       : ${metrics.fps.toFixed(0)}`,
      ];

      y = 15;
      ctx.textAlign = 'right';

      params.forEach(p => {
        if (p.startsWith('//')) ctx.fillStyle = 'rgba(122,132,118,0.6)';
        else ctx.fillStyle = 'rgba(214, 222, 216, 0.9)';
        ctx.fillText(p, w - 15, y);
        y += 12;
      });

      ctx.restore();
    };

    const drawAmoeba = (ctx: CanvasRenderingContext2D, b: BubbleExt, w: number, h: number, blurAmount: number, overlap: boolean, nowMs: number) => {
      const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
      const cx = w / 2; const cy = h / 2;
      const x2d = (b.x - cx) * scale + cx;
      const y2d = (b.y - cy) * scale + cy;
      const r2d = b.radius * scale;

      if (r2d < 1) return;

      ctx.save();
      const blurPx = Math.min(3, Math.max(0, blurAmount));
      if (blurPx > 0.1) ctx.filter = `blur(${blurPx}px)`;
      ctx.translate(x2d, y2d);
      ctx.rotate(b.deformation.rotation);
      ctx.scale(b.deformation.scaleX, b.deformation.scaleY);

      const drawDotText = (text: string, alpha: number, scaleFactor: number) => {
        const layout = getDotTextLayout(text);
        if (!layout) return;
        const { glyphs, rows, colsList, totalCols } = layout;
        const gapCols = 1;
        if (totalCols <= 0) return;

        const cellBase = Math.min(r2d * 0.32, r2d / (rows + 2));
        const maxWidth = r2d * 1.35 * scaleFactor;
        const cell = Math.min(cellBase, maxWidth / totalCols);
        const dotR = Math.max(0.6, cell * 0.42);
        const halfH = ((rows - 1) * cell) / 2;
        let cursorX = -((totalCols - 1) * cell) / 2;
        const angleStep = (Math.PI * 2) / VERTEX_COUNT;

        ctx.save();
        ctx.globalAlpha = Math.min(0.9, alpha);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(0.6, dotR * 0.2);
        for (let gi = 0; gi < glyphs.length; gi++) {
          const pattern = glyphs[gi];
          const cols = colsList[gi];
          for (let r = 0; r < pattern.length; r++) {
            const row = pattern[r];
            for (let c = 0; c < row.length; c++) {
              if (row[c] !== '1') continue;
              const dx = cursorX + c * cell;
              const dy = -halfH + r * cell;
              const angle = Math.atan2(dy, dx);
              const vertexIndex = ((Math.round((angle + Math.PI) / angleStep) % VERTEX_COUNT) + VERTEX_COUNT) % VERTEX_COUNT;
              const warp = b.vertices[vertexIndex] ?? 1;
              const warpScale = 1 + (warp - 1) * 0.7;
              const wx = dx * warpScale;
              const wy = dy * warpScale;
              const wr = dotR * (0.9 + (warp - 1) * 0.35);
              ctx.beginPath();
              ctx.arc(wx, wy, wr, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
          cursorX += (cols + gapCols) * cell;
        }
        ctx.restore();
      };

      ctx.beginPath();
      const angleStep = (Math.PI * 2) / VERTEX_COUNT;
      const points = amoebaPointsRef.current;
      for (let i = 0; i < VERTEX_COUNT; i++) {
        const r = r2d * b.vertices[i];
        const a = i * angleStep;
        const p = points[i];
        p.x = Math.cos(a) * r;
        p.y = Math.sin(a) * r;
      }

      const last = points[points.length - 1];
      const first = points[0];
      const startX = (last.x + first.x) / 2;
      const startY = (last.y + first.y) / 2;
      ctx.moveTo(startX, startY);
      for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
      }
      ctx.closePath();

      ctx.fillStyle = b.color;
      ctx.globalAlpha = Math.max(0.1, 1 - (b.z / DEPTH));
      ctx.fill();
      ctx.filter = 'none';
      const depthT = Math.max(0, Math.min(1, b.z / DEPTH));
      ctx.lineWidth = Math.max(0.6, 1.4 - depthT * 0.8);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.globalAlpha = Math.max(0.25, 0.9 - depthT * 0.5);
      const prevComp = ctx.globalCompositeOperation;
      if (overlap) ctx.globalCompositeOperation = 'difference';
      ctx.stroke();
      ctx.globalCompositeOperation = prevComp;

      const overlay = b.digitOverlay;
      if (overlay && r2d >= DIGIT_OVERLAY_MIN_R2D) {
        const remaining = overlay.until - nowMs;
        if (remaining > 0) {
          const age = nowMs - overlay.since;
          const fade = DIGIT_OVERLAY_FADE_MS;
          let alpha = 1;
          if (age < fade) alpha = age / fade;
          if (remaining < fade) alpha = Math.min(alpha, remaining / fade);
          if (alpha > 0.05) drawDotText(overlay.digit, alpha * 0.9, 1);
        }
      }

      if (!overlay && r2d >= DIGIT_OVERLAY_MIN_R2D) {
        const label = getSourceLabel(b.audioSource ?? null);
        const labelAlpha = b.labelAlpha ?? 0;
        if (label && labelAlpha > 0.02) drawDotText(label, labelAlpha, 0.85);
      }

      ctx.restore();
    };

    const drawWallReflections = (
      ctx: CanvasRenderingContext2D,
      bubbles: BubbleExt[],
      w: number,
      h: number,
      warp: number,
      wave: number,
      time: number,
    ) => {
      if (!bubbles.length) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      const { front, back } = updateRoomWarp(w, h, warp, wave, time);
      const fTL = front[0];
      const fTR = front[1];
      const fBR = front[2];
      const fBL = front[3];
      const bTL = back[0];
      const bTR = back[1];
      const bBR = back[2];
      const bBL = back[3];

      const center = {
        x: (fTL.x + fTR.x + fBR.x + fBL.x + bTL.x + bTR.x + bBR.x + bBL.x) / 8,
        y: (fTL.y + fTR.y + fBR.y + fBL.y + bTL.y + bTR.y + bBR.y + bBL.y) / 8,
        z: (fTL.z + fTR.z + fBR.z + fBL.z + bTL.z + bTR.z + bBR.z + bBL.z) / 8,
      };

      const leftPlane = planeFromPoints(fTL, fBL, bBL, center);
      const rightPlane = planeFromPoints(fTR, fBR, bBR, center);
      const topPlane = planeFromPoints(fTL, fTR, bTR, center);
      const bottomPlane = planeFromPoints(fBL, fBR, bBR, center);
      const backPlane = planeFromPoints(bTL, bTR, bBR, center);

      const proxForPlane = (plane: Plane, pos: Vec3, radius: number, range: number) => {
        const dist = planeDistance(plane, pos);
        if (dist <= 0) return 0;
        const surfaceDist = dist - radius;
        if (surfaceDist >= range) return 0;
        return clamp01((range - Math.max(0, surfaceDist)) / range);
      };

      const drawReflection = (ref: BubbleExt, alpha: number) => {
        if (alpha <= 0) return;
        const scale = FOCAL_LENGTH / (FOCAL_LENGTH + ref.z);
        const cx = w / 2; const cy = h / 2;
        const x2d = (ref.x - cx) * scale + cx;
        const y2d = (ref.y - cy) * scale + cy;
        const r2d = ref.radius * scale;
        if (r2d < 2) return;

        ctx.save();
        ctx.translate(x2d, y2d);
        ctx.rotate(ref.deformation.rotation);
        ctx.scale(ref.deformation.scaleX, ref.deformation.scaleY);

        const depthT = Math.max(0, Math.min(1, ref.z / DEPTH));
        ctx.globalAlpha = alpha * (0.75 - depthT * 0.35);
        ctx.fillStyle = ref.color;
        ctx.imageSmoothingEnabled = false;

        const cell = Math.max(1.6, Math.min(4.5, r2d / 7));
        const half = Math.max(1, Math.ceil(r2d / cell));
        const angleStep = (Math.PI * 2) / VERTEX_COUNT;
        for (let iy = -half; iy <= half; iy++) {
          for (let ix = -half; ix <= half; ix++) {
            const dx = ix * cell;
            const dy = iy * cell;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > r2d * 1.35) continue;
            const ang = Math.atan2(dy, dx);
            const vertexIndex = ((Math.round((ang + Math.PI) / angleStep) % VERTEX_COUNT) + VERTEX_COUNT) % VERTEX_COUNT;
            const warp = ref.vertices[vertexIndex] ?? 1;
            const warpR = r2d * (1 + (warp - 1) * 0.65);
            if (dist <= warpR) {
              ctx.fillRect(dx - cell * 0.45, dy - cell * 0.45, cell * 0.9, cell * 0.9);
            }
          }
        }
        ctx.restore();
      };

      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        const depthFade = 1 - Math.min(1, b.z / DEPTH) * 0.6;
        const dim = 0.75;
        const baseAlpha = 0.05 * depthFade;

        const proxLeft = proxForPlane(leftPlane, b, b.radius, REFLECT_RANGE);
        const proxRight = proxForPlane(rightPlane, b, b.radius, REFLECT_RANGE);
        const proxTop = proxForPlane(topPlane, b, b.radius, REFLECT_RANGE);
        const proxBottom = proxForPlane(bottomPlane, b, b.radius, REFLECT_RANGE);
        const proxBack = proxForPlane(backPlane, b, b.radius, REFLECT_BACK_RANGE);

        if (proxLeft > 0) {
          const refPos = reflectAcrossPlane(b, leftPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + proxLeft * 0.22) * dim);
        }

        if (proxRight > 0) {
          const refPos = reflectAcrossPlane(b, rightPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + proxRight * 0.22) * dim);
        }

        if (proxTop > 0) {
          const refPos = reflectAcrossPlane(b, topPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + proxTop * 0.18) * dim);
        }

        if (proxBottom > 0) {
          const refPos = reflectAcrossPlane(b, bottomPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + proxBottom * 0.18) * dim);
        }

        if (proxBack > 0) {
          const refPos = reflectAcrossPlane(b, backPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + proxBack * 0.16) * dim);
        }

        if (proxLeft > 0 && proxTop > 0) {
          const refPos = reflectAcrossPlane(reflectAcrossPlane(b, leftPlane), topPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + (proxLeft * proxTop) * 0.2) * dim);
        }
        if (proxLeft > 0 && proxBottom > 0) {
          const refPos = reflectAcrossPlane(reflectAcrossPlane(b, leftPlane), bottomPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + (proxLeft * proxBottom) * 0.2) * dim);
        }
        if (proxRight > 0 && proxTop > 0) {
          const refPos = reflectAcrossPlane(reflectAcrossPlane(b, rightPlane), topPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + (proxRight * proxTop) * 0.2) * dim);
        }
        if (proxRight > 0 && proxBottom > 0) {
          const refPos = reflectAcrossPlane(reflectAcrossPlane(b, rightPlane), bottomPlane);
          const ref: BubbleExt = { ...b, x: refPos.x, y: refPos.y, z: refPos.z, digitOverlay: undefined, audioSource: null, labelAlpha: 0, labelTargetAlpha: 0 };
          drawReflection(ref, (baseAlpha + (proxRight * proxBottom) * 0.2) * dim);
        }
      }

      ctx.restore();
    };

    const drawRoom = (ctx: CanvasRenderingContext2D, w: number, h: number, warp: number, wave: number, time: number) => {
      ctx.save();
      ctx.strokeStyle = '#B9BCB7';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);

      const cache = ensureRoomCache(w, h);
      const { frontBase, backBase, front, back, frontProj, backProj } = cache;
      for (let i = 0; i < front.length; i++) {
        front[i].x = frontBase[i].x;
        front[i].y = frontBase[i].y;
        front[i].z = frontBase[i].z;
        back[i].x = backBase[i].x;
        back[i].y = backBase[i].y;
        back[i].z = backBase[i].z;
      }

      const project = (p: Vec3, out: Vec2) => {
        const scale = FOCAL_LENGTH / (FOCAL_LENGTH + p.z);
        out.x = (p.x - w / 2) * scale + w / 2;
        out.y = (p.y - h / 2) * scale + h / 2;
        return out;
      };

      const warpAmt = warp * 0.35;
      const waveScale = wave * 0.35; // 65% softer
      const waveAmt = waveScale * 0.25;
      const wavePhase = time * 0.6;

      const warpOffset = (ix: number, iy: number, iz: number, out: Vec3) => {
        const dx = (Math.sin(wavePhase + ix * 0.5 + iy * 0.3) + 1) * 0.5;
        const dy = (Math.cos(wavePhase * 0.7 + ix * 0.2 + iy * 0.6) + 1) * 0.5;
        out.x = (dx - 0.5) * warpAmt * w;
        out.y = (dy - 0.5) * warpAmt * h;
        out.z = (Math.sin(wavePhase + iz) + 1) * 0.5 * warpAmt * DEPTH * 0.3;
      };

      const fTL = front[0];
      const fTR = front[1];
      const fBR = front[2];
      const fBL = front[3];

      const bTL = back[0];
      const bTR = back[1];
      const bBR = back[2];
      const bBL = back[3];

      [fTL, fTR, fBR, fBL].forEach((p, idx) => {
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.6) : 0;
        p.x += (idx === 0 ? -1 : idx === 1 ? 1 : 0) * warpAmt * w * 0.2;
        p.y += (idx === 0 ? -1 : idx === 3 ? 1 : 0) * warpAmt * h * 0.15;
        p.z += wv * DEPTH * 0.1;
      });
      const offs: Vec3 = { x: 0, y: 0, z: 0 };
      [bTL, bTR, bBR, bBL].forEach((p, idx) => {
        warpOffset(idx, idx * 0.3, idx * 0.5, offs);
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.8 + 1.2) : 0;
        p.x += offs.x;
        p.y += offs.y;
        p.z += offs.z + wv * DEPTH * 0.2;
      });

      ctx.strokeStyle = 'rgba(185, 188, 183, 0.15)';

      ctx.strokeStyle = 'rgba(185, 188, 183, 0.4)';
      const pfTL = project(fTL, frontProj[0]); const pbTL = project(bTL, backProj[0]);
      const pfTR = project(fTR, frontProj[1]); const pbTR = project(bTR, backProj[1]);
      const pfBR = project(fBR, frontProj[2]); const pbBR = project(bBR, backProj[2]);
      const pfBL = project(fBL, frontProj[3]); const pbBL = project(bBL, backProj[3]);

      ctx.beginPath(); ctx.moveTo(pfTL.x, pfTL.y); ctx.lineTo(pbTL.x, pbTL.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfTR.x, pfTR.y); ctx.lineTo(pbTR.x, pbTR.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfBR.x, pfBR.y); ctx.lineTo(pbBR.x, pbBR.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfBL.x, pfBL.y); ctx.lineTo(pbBL.x, pbBL.y); ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(pbTL.x, pbTL.y); ctx.lineTo(pbTR.x, pbTR.y); ctx.lineTo(pbBR.x, pbBR.y); ctx.lineTo(pbBL.x, pbBL.y);
      ctx.closePath(); ctx.stroke();

      ctx.restore();
    };

    const drawVoid = (ctx: CanvasRenderingContext2D, w: number, h: number, strength: number, time: number) => {
      if (strength <= 0.02) return;
      const gradCanvas = ensureVoidGradient(w, h, strength);
      if (gradCanvas) ctx.drawImage(gradCanvas, 0, 0);
      const cx = w / 2;
      const cy = h / 2;
      const core = 18 + strength * 70;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.rotate(time * 0.15 + strength * 0.4);
      ctx.strokeStyle = `rgba(120, 126, 118, ${0.12 + strength * 0.2})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      for (let i = 0; i < 3; i++) {
        const r = core * (0.9 + i * 0.45);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.2, r * 0.75, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.rotate(-time * 0.25);
      ctx.strokeStyle = `rgba(15, 15, 15, ${0.45 + strength * 0.2})`;
      ctx.setLineDash([]);
      for (let i = 0; i < 4; i++) {
        const r = core * 0.6 + i * 6;
        ctx.beginPath();
        ctx.arc(0, 0, r, time * 0.4 + i, time * 0.4 + i + Math.PI * 1.2);
        ctx.stroke();
      }
      ctx.restore();

      ctx.restore();
    };

    const drawHUD = (ctx: CanvasRenderingContext2D, pairs: { b1: BubbleExt | null; b2: BubbleExt | null }[], w: number, h: number) => {
      ctx.save();
      ctx.font = '10px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#4A4F4A';

      pairs.forEach(({ b1, b2 }) => {
        if (!b1 || !b2) return;
        const scale1 = FOCAL_LENGTH / (FOCAL_LENGTH + b1.z);
        const scale2 = FOCAL_LENGTH / (FOCAL_LENGTH + b2.z);
        const cx = w / 2; const cy = h / 2;

        const x1 = (b1.x - cx) * scale1 + cx;
        const y1 = (b1.y - cy) * scale1 + cy;
        const x2 = (b2.x - cx) * scale2 + cx;
        const y2 = (b2.y - cy) * scale2 + cy;
        const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;

        ctx.strokeStyle = '#7A8476'; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

        const avgZ = (b1.z + b2.z) / 2;
        const depthT = Math.min(1, Math.max(0, avgZ / DEPTH));
        const fontSize = 10 - depthT * 3; // smaller when farther
        const alpha = 0.9 - depthT * 0.6; // fade with depth

        ctx.font = `${fontSize}px "Courier New", monospace`;
        const info = `[X:${Math.round((b1.x + b2.x) / 2)} Y:${Math.round((b1.y + b2.y) / 2)} Z:${Math.round((b1.z + b2.z) / 2)}]`;

        const textWidth = ctx.measureText(info).width;
        ctx.fillStyle = `rgba(242, 242, 240, ${Math.max(0, alpha - 0.1)})`;
        ctx.fillRect(mx - textWidth / 2 - 2, my - (fontSize + 4), textWidth + 4, fontSize + 2);

        ctx.fillStyle = `rgba(46, 47, 43, ${alpha})`;
        ctx.fillText(info, mx, my - (fontSize * 0.6));
      });
      ctx.restore();
    };

    const drawSpatialGyro = (ctx: CanvasRenderingContext2D, w: number, h: number, time: number) => {
      const layout = getGyroLayout(w, h);
      const { cx, cy, rings } = layout;
      const state = gyroStateRef.current;
      const activeRing = gyroDragRef.current.active ? gyroDragRef.current.ring : null;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.9);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineWidth = GYRO_THICKNESS;
      ctx.lineCap = 'round';

      rings.forEach((ring, idx) => {
        const spin = time * (0.08 + idx * 0.04);
        const baseAlpha = activeRing === ring.id ? 0.65 : 0.35;
        ctx.save();
        ctx.rotate(spin);
        ctx.strokeStyle = `rgba(214, 222, 216, ${baseAlpha + pulse * 0.15})`;
        ctx.setLineDash([8, 10]);
        ctx.beginPath();
        ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(122, 132, 118, ${0.25 + pulse * 0.2})`;
        ctx.beginPath();
        ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
        ctx.stroke();

        const value =
          ring.id === 'pan' ? state.pan : ring.id === 'depth' ? state.depth : state.width;
        const ang = valueToAngle(value);
        const hx = Math.cos(ang) * ring.r;
        const hy = Math.sin(ang) * ring.r;
        ctx.fillStyle = `rgba(242, 242, 240, ${0.75 + pulse * 0.2})`;
        ctx.strokeStyle = `rgba(122, 132, 118, ${0.7 + pulse * 0.2})`;
        ctx.beginPath();
        ctx.rect(hx - GYRO_HANDLE, hy - GYRO_HANDLE, GYRO_HANDLE * 2, GYRO_HANDLE * 2);
        ctx.fill();
        ctx.stroke();
      });

      const stereo = audioService.getStereoLevels();
      const meter = stereoRef.current;
      const targetL = clamp01(stereo.left);
      const targetR = clamp01(stereo.right);
      meter.left += (targetL - meter.left) * 0.25;
      meter.right += (targetR - meter.right) * 0.25;

      const autoLayout = getGyroAutoLayout(layout);
      const { circleR, circleGap, autoR, autoY } = autoLayout;
      const barW = Math.max(2, circleR * 0.45);
      const barMax = Math.max(4, circleR * 1.6);

      const drawStereoCircle = (cx: number, level: number) => {
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(32, 34, 30, 0.45)';
        ctx.strokeStyle = 'rgba(122, 132, 118, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, 0, circleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, 0, circleR - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(214, 222, 216, 0.95)';
        const barBoost = 1.2;
        const barH = Math.min(barMax, barMax * level * barBoost);
        const barTop = circleR - 2 - barH;
        ctx.fillRect(cx - barW / 2, barTop, barW, barH);

        const lineW = circleR * 2 + 2;
        const lineH = Math.max(1, barW * 0.2);
        ctx.fillStyle = 'rgba(214, 222, 216, 0.6)';
        ctx.fillRect(cx - lineW / 2, barTop - lineH * 0.5, lineW, lineH);
        ctx.restore();
        ctx.restore();
      };

      const stereoOffset = circleR + circleGap * 0.5;
      drawStereoCircle(-stereoOffset, meter.left);
      drawStereoCircle(stereoOffset, meter.right);

      const isAuto = gyroAutoRef.current.enabled;
      const lissajous = audioService.getStereoWaveform();
      const lissajousR = Math.max(autoR * 1.55, circleR * 2.05);
      const lissajousY = -autoY + 4;
      const drawLissajous = (y: number) => {
        if (!lissajous) return;
        const left = lissajous.left;
        const right = lissajous.right;
        const step = Math.max(1, Math.floor(left.length / 120));
        const radius = lissajousR;
        const boost = 1.3;
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, y, radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = 'rgba(122, 132, 118, 0.45)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let i = 0; i < left.length; i += step) {
          const lx = left[i] || 0;
          const ry = right[i] || 0;
          const px = lx * radius * boost;
          const py = ry * radius * boost + y;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      };
      const drawAutoCircle = (y: number, alpha: number, showGlyph: boolean) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = isAuto ? 'rgba(214, 222, 216, 0.85)' : 'rgba(32, 34, 30, 0.45)';
        ctx.strokeStyle = isAuto ? 'rgba(214, 222, 216, 0.85)' : 'rgba(122, 132, 118, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, y, autoR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (showGlyph) {
          ctx.fillStyle = isAuto ? 'rgba(46, 47, 43, 0.95)' : 'rgba(214, 222, 216, 0.75)';
          ctx.font = isAuto ? '10px "Courier New", monospace' : 'bold 12px "Courier New", monospace';
          ctx.fillText(isAuto ? '\u2013' : '.', 0, y + (isAuto ? 0.4 : -0.2));
        }
        ctx.restore();
      };

      drawLissajous(lissajousY);
      drawAutoCircle(autoY, 0.9, true);

      ctx.font = '8px "Courier New", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(214, 222, 216, 0.7)';
      const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
      const labelX = rings[rings.length - 1].r + 8;
      let textY = -rings[rings.length - 1].r * 0.9;
      ctx.fillText(`PAN   ${fmt(state.pan)}`, labelX, textY);
      textY += 10;
      ctx.fillText(`DEPTH ${fmt(state.depth)}`, labelX, textY);
      textY += 10;
      ctx.fillText(`WIDTH ${fmt(state.width)}`, labelX, textY);

      ctx.restore();
    };

    const clampBubble = (b: BubbleExt, tempo: number) => {
      const maxV = MAX_SPEED * Math.max(0.2, tempo);
      const vx = b.vx, vy = b.vy, vz = b.vz;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > maxV && sp > EPS) {
        const s = maxV / sp;
        b.vx *= s; b.vy *= s; b.vz *= s;
      }
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z) ||
          !Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.vz)) {
        b.x = Math.max(0, Math.min((canvasRef.current?.width ?? 1000), Number.isFinite(b.x) ? b.x : 0));
        b.y = Math.max(0, Math.min((canvasRef.current?.height ?? 500), Number.isFinite(b.y) ? b.y : 0));
        b.z = Math.max(0, Math.min(DEPTH, Number.isFinite(b.z) ? b.z : 0));
        b.vx = 0; b.vy = 0; b.vz = 0;
      }
    };

    const applySchooling = (bubbles: BubbleExt[], wave: number, tempo: number, time: number) => {
      const w = wave * 0.35; // 65% reduction
      if (w < 0.01 || bubbles.length < 2) return;
      const neighborR = 180 + w * 320;
      const neighborSq = neighborR * neighborR;
      const sepR = 80 + w * 120;
      const sepSq = sepR * sepR;
      const alignW = 0.04 * w * Math.max(0.4, tempo);
      const cohW = 0.02 * w * Math.max(0.4, tempo);
      const sepW = 0.08 * w * Math.max(0.4, tempo);
      const sway = 6 * w;

      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        let count = 0;
        let ax = 0, ay = 0, az = 0;
        let cx = 0, cy = 0, cz = 0;
        let sx = 0, sy = 0, sz = 0;

        for (let j = 0; j < bubbles.length; j++) {
          if (i === j) continue;
          const o = bubbles[j];
          const dx = o.x - b.x;
          const dy = o.y - b.y;
          const dz = o.z - b.z;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq > neighborSq) continue;
          count++;
          ax += o.vx; ay += o.vy; az += o.vz;
          cx += o.x; cy += o.y; cz += o.z;
          if (dSq < sepSq) {
            const inv = 1 / Math.sqrt(Math.max(EPS, dSq));
            sx -= dx * inv;
            sy -= dy * inv;
            sz -= dz * inv;
          }
        }

        if (count > 0) {
          const invC = 1 / count;
          b.vx += (ax * invC - b.vx) * alignW;
          b.vy += (ay * invC - b.vy) * alignW;
          b.vz += (az * invC - b.vz) * alignW;

          b.vx += (cx * invC - b.x) * cohW;
          b.vy += (cy * invC - b.y) * cohW;
          b.vz += (cz * invC - b.z) * cohW;
        }

        b.vx += sx * sepW;
        b.vy += sy * sepW;
        b.vz += sz * sepW;

        const swayPhase = b.vertexPhases[0] ?? 0;
        b.vx += Math.sin(time * 1.2 + b.x * 0.01 + swayPhase) * sway * 0.2;
        b.vy += Math.cos(time * 1.1 + b.y * 0.01 + swayPhase * 0.3) * sway * 0.15;
      }
    };

    // MAIN LOOP
    useEffect(() => {
      if (containerRef.current && canvasRef.current) {
        canvasRef.current.width = containerRef.current.clientWidth;
        canvasRef.current.height = containerRef.current.clientHeight;
        resetCachesForSize();
      }

      const animate = () => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = getCanvasContext(canvas);
        if (!ctx) return;

        // FPS measure
        const fpsState = fpsRef.current;
        const now = performance.now();
        const dt = now - fpsState.last;
        fpsState.last = now;
        fpsState.acc += dt;
        fpsState.frames += 1;
        const hiddenOrThrottled = visibilityRef.current || dt > 300;
        if (hiddenOrThrottled) {
          fpsState.acc = 0;
          fpsState.frames = 0;
          fpsState.fps = FPS_OK;
          perfRef.current.recovering = false;
          perfRef.current.lockUntilHighFps = false;
          perfRef.current.recoverAboveMs = 0;
          perfRef.current.shredDelayUntil = 0;
          requestRef.current = requestAnimationFrame(animate);
          return;
        }
        if (fpsState.acc >= 500) {
          fpsState.fps = (fpsState.frames / fpsState.acc) * 1000;
          fpsState.acc = 0;
          fpsState.frames = 0;
        }

        // Performance guard: if FPS tanks below 30, enable shred + block budding until recovery to ~60
        const perf = perfRef.current;
        const wasRecovering = perf.recovering;
        if (fpsState.fps > FPS_GUARD_GOOD) {
          perf.recovering = false;
          perf.lockUntilHighFps = false;
          perf.recoverAboveMs = 0;
        } else if (fpsState.fps > FPS_GUARD_OK && !perf.lockUntilHighFps) {
          perf.recovering = false;
          perf.recoverAboveMs = 0;
        } else if (fpsState.fps > 0 && fpsState.fps < FPS_GUARD_RECOVER) {
          perf.recovering = true;
          perf.lockUntilHighFps = true;
          perf.recoverAboveMs = 0;
        } else if (perf.lockUntilHighFps) {
          if (fpsState.fps >= FPS_GUARD_RECOVER) {
            perf.recoverAboveMs += dt;
            if (perf.recoverAboveMs >= FPS_GUARD_RELEASE_MS) {
              perf.recovering = false;
              perf.lockUntilHighFps = false;
              perf.recoverAboveMs = 0;
            }
          } else {
            perf.recoverAboveMs = 0;
          }
        }
        if (!wasRecovering && perf.recovering) {
          perf.shredDelayUntil = now + SHRED_RECOVERY_DELAY_MS;
        }
        if (!perf.recovering) {
          perf.shredDelayUntil = 0;
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        const backCanvas = ensureBackground(canvas.width, canvas.height);
        if (backCanvas) {
          ctx.drawImage(backCanvas, 0, 0);
        } else {
          ctx.fillStyle = '#2E2F2B';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const gradientBack = ctx.createLinearGradient(0, 0, 0, canvas.height);
          gradientBack.addColorStop(0, '#2E2F2B');
          gradientBack.addColorStop(1, '#3F453F');
          ctx.fillStyle = gradientBack;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        const phys = physicsRef.current;
        const audio = audioSettingsRef.current;
        const time = Date.now() * 0.002 * Math.max(0.1, phys.tempo || 0);
        const nowMs = performance.now();
        const frameId = (frameIdRef.current = frameIdRef.current + 1);
        updateGyroAuto(nowMs);
        const peakDb = audioService.getPeakLevel();
        const poolSize = audioService.getActivePoolSize();
        if (digitRef.current.nextAt < nowMs) {
          const shouldSpawn = poolSize === 3 || poolSize === 6 || poolSize === 9;
          if (shouldSpawn) assignDigitOverlay(String(poolSize) as DigitChar, nowMs);
          digitRef.current.nextAt = nowMs + 8000 + Math.random() * 12000;
        }
        const bankSnapshot = audioService.getBankSnapshot();
        drawMatrixLog(ctx, canvas.width, canvas.height, {
          peakDb,
          baseFreq: audio.baseFrequency,
          objects: bubblesRef.current.length,
          fps: fpsRef.current.fps,
        });
        drawRoom(ctx, canvas.width, canvas.height, phys.geometryWarp, phys.roomWave, time);
        drawVoid(ctx, canvas.width, canvas.height, phys.blackHole, time);

        const bubbles = bubblesRef.current;
        const hasSources =
          bankSnapshot.synthEnabled ||
          bankSnapshot.mic.some(Boolean) ||
          bankSnapshot.smp.some(Boolean);
        if (hasSources) {
          const unassigned = bubbles.filter((b) => !b.audioSource);
          if (unassigned.length) {
            unassigned.sort(() => Math.random() - 0.5);
            unassigned.forEach((b) => {
              const source = audioService.assignSourceToBubble();
              if (!source) return;
              b.audioSource = source;
              b.labelAlpha = 0;
              b.labelTargetAlpha = 0.6;
            });
          }
        }
        const particles = particlesRef.current;
        const recovering = perfRef.current.recovering;
        const fpsNow = fpsRef.current.fps;
        const severity = recovering ? Math.max(0, FPS_GUARD_RECOVER - Math.max(0, fpsNow)) / FPS_GUARD_RECOVER : 0;
        let shredQuota = 0;
        const shredReady = recovering && nowMs >= perfRef.current.shredDelayUntil;
        const safeMin = Math.max(SHRED_MIN_BUBBLES, poolSize);
        if (shredReady && bubbles.length > safeMin) {
          // Gradual decay: remove a small fraction per frame based on severity, capped
          shredQuota = Math.max(1, Math.floor(bubbles.length * (0.01 + severity * 0.03)));
          shredQuota = Math.min(shredQuota, Math.max(1, Math.floor(bubbles.length * 0.06)));
          shredQuota = Math.min(shredQuota, bubbles.length - safeMin);
        }

        if (!isPlayingRef.current) {
          bubbles.sort((a, b) => b.z - a.z);
          drawWallReflections(ctx, bubbles, canvas.width, canvas.height, phys.geometryWarp, phys.roomWave, time);
          bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, 0, false, nowMs));
          drawSpatialGyro(ctx, canvas.width, canvas.height, time);
          requestRef.current = requestAnimationFrame(animate);
          return;
        }

        const { tempo, gravity, buddingChance, cannibalism, wind, blackHole, weakness, magneto, fragmentation, freeze, roomWave } = phys;
        const cx = canvas.width / 2; const cy = canvas.height / 2;
        const voidZ = VOID_PLANE_Z;

        // --- PARTICLE LOOP ---
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.x += p.vx * tempo; p.y += p.vy * tempo; p.z += p.vz * tempo;
          p.life -= 0.02 * tempo;
          if (p.life <= 0) {
            const last = particles.pop();
            if (last && last !== p) {
              particles[i] = last;
              i--;
            }
            releaseParticle(p);
            continue;
          }

          const scale = FOCAL_LENGTH / (FOCAL_LENGTH + p.z);
          const x2d = (p.x - cx) * scale + cx;
          const y2d = (p.y - cy) * scale + cy;
          const size = p.size * scale;

          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.life;
          ctx.fillRect(x2d, y2d, size, size);
        }

        // Schooling / wave behaviour (fish-like swirls)
        applySchooling(bubbles, roomWave, tempo, time);

        // --- BUBBLE PHYSICS (local forces) ---
        for (let i = 0; i < bubbles.length; i++) {
          const b = bubbles[i];
          if (b.audioSource && !isSourceValid(b.audioSource, bankSnapshot)) {
            b.labelTargetAlpha = 0;
          }
          if (b.labelTargetAlpha === undefined) {
            b.labelTargetAlpha = b.audioSource ? 0.6 : 0;
          }
          const labelTarget = b.labelTargetAlpha ?? 0;
          const labelAlpha = b.labelAlpha ?? labelTarget;
          b.labelAlpha = labelAlpha + (labelTarget - labelAlpha) * 0.08;
          if (b.labelAlpha < 0.02 && labelTarget === 0) {
            b.labelAlpha = 0;
            b.audioSource = null;
          }
          if (b.digitImpactsLeft !== undefined && b.digitImpactsLeft <= 0) {
            spawnPuff(b);
            if (removeBubbleAt(bubbles, i)) i--;
            continue;
          }

          // Freeze (Viscosity)
          if (freeze > 0) {
            const drag = 1 - (freeze * 0.1 * tempo);
            b.vx *= drag;
            b.vy *= drag;
            b.vz *= drag;
          }

          // Auto shred if perf drops (gradual, not all at once)
          if (
            shredReady &&
            shredQuota > 0 &&
            bubbles.length > safeMin &&
            (!b.spawnedAt || (nowMs - b.spawnedAt) > SHRED_GRACE_MS) &&
            Math.random() < (0.25 + severity * 0.35)
          ) {
            for (let k = 0; k < 32; k++) spawnParticle(b.x, b.y, b.z, b.color);
            pushLog(`FPS_SHRED: ${b.id}`);
            shredQuota -= 1;
            if (removeBubbleAt(bubbles, i)) i--;
            continue;
          }

          if (fragmentation > 0 && Math.random() < fragmentation * 0.005) {
            for (let k = 0; k < 32; k++) spawnParticle(b.x, b.y, b.z, b.color);
            pushLog(`ERR_FRAG: ${b.id}`);
            if (removeBubbleAt(bubbles, i)) i--;
            continue;
          }

          if (weakness > 0) {
            b.radius -= (weakness * 0.1) * tempo;
            if (b.radius < 5) {
              if (removeBubbleAt(bubbles, i)) i--;
              continue;
            }
          }

          const blackHoleEff = Math.max(0, blackHole - 0.08);
          if (blackHoleEff > 0.001) {
            // VOID: central gravity + frame-drag swirl + accretion (tangential drag)
            // Use XY distance for the "on-screen" spiral; Z is treated as a funnel into depth.
            const dx = cx - b.x;
            const dy = cy - b.y;
            const dzVoid = voidZ - b.z;
            const rSq = dx * dx + dy * dy;
            const distSq3d = rSq + dzVoid * dzVoid;
            const r = Math.sqrt(Math.max(EPS, rSq));
            const dist3d = Math.sqrt(Math.max(EPS, distSq3d));
            const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
            const r2d = r * scale;
            const dist3d2d = dist3d * scale;

            // event horizon in *screen space* (projection), so it matches what the player sees
            const bhCurve = blackHoleEff * blackHoleEff;
            const horizon = 14 + bhCurve * 90;
            const horizonWithSize = horizon + (b.radius * scale) * 0.2;
            const horizonHit = dist3d2d < horizonWithSize;
            let shouldSwallow = false;
            if (horizonHit) {
              if (!b.voidEnteredAt) {
                b.voidEnteredAt = nowMs;
                b.voidGraceMs = 1000 + Math.random() * 1000; // 1-2s grace to show spiral
              }
              const elapsed = nowMs - (b.voidEnteredAt ?? nowMs);
              if (elapsed >= (b.voidGraceMs ?? 0)) shouldSwallow = true;
            } else {
              b.voidEnteredAt = undefined;
              b.voidGraceMs = undefined;
            }
            if (shouldSwallow) {
              if (removeBubbleAt(bubbles, i)) i--;
              continue;
            }

            const ux = dx / r;
            const uy = dy / r;
            const uz = dzVoid / dist3d;
            const tx = -uy;
            const ty = ux;

            // Newtonian-like gravity with softening + accel clamp for stability
            const gm = 32000 * bhCurve + 6000 * blackHoleEff;
            const soft = 2500; // px^2
            const reachFalloff = 1 / (1 + (dist3d / 900));
            let a = (gm / (distSq3d + soft)) * reachFalloff;
            const maxA = MAX_ACCEL * Math.max(0.2, tempo);
            if (a > maxA) a = maxA;

            // "Spin": swirl is proportional to gravity (stronger near the hole, weaker far away)
            const swirlFloor = 0.02 + 0.18 * blackHoleEff;
            const aTan = a * (0.06 + 0.22 * blackHoleEff) + swirlFloor * reachFalloff;

            b.vx += ux * a + tx * aTan;
            b.vy += uy * a + ty * aTan;
            b.vz += uz * a;

            // Depth funnel: pull towards mid-depth so bubbles don't "bounce" off the back wall.
            const funnel = (1 / (1 + (dist3d / 900))) * bhCurve;
            b.vz += uz * a * 0.25 * funnel;

            // Accretion drag: remove angular momentum so orbits become spirals
            const vTan = b.vx * tx + b.vy * ty;
            const dragT = Math.min(0.08, (0.01 + 0.07 * blackHoleEff) * funnel * Math.max(0.2, tempo));
            b.vx -= tx * vTan * dragT;
            b.vy -= ty * vTan * dragT;

            // Small damping to counter the injected swirl energy (keeps capture stable)
            const damp = 1 - Math.min(0.06, dragT * 0.25);
            b.vx *= damp; b.vy *= damp; b.vz *= damp;
          } else {
            b.vy += gravity * 0.15;
          }

          if (wind > 0) {
            const windForce = wind * 0.15;
            b.vx += (Math.random() - 0.5) * windForce;
            b.vy += (Math.random() - 0.5) * windForce;
            b.vz += (Math.random() - 0.5) * windForce;
          }

          // integrate
          b.x += b.vx * tempo; b.y += b.vy * tempo; b.z += b.vz * tempo;

          // Elasticity + jelly offsets
          const elasticity = 0.25 + (0.25 * (1 - freeze));
          for (let j = 0; j < VERTEX_COUNT; j++) {
            const base = 1 + (
              Math.sin(time * 1.5 + b.vertexPhases[j]) * elasticity * 0.6 +
              Math.sin(time * 0.8 + j) * elasticity * 0.4
            );
            const local = b.jelly ? b.jelly.vOff[j] : 0;
            b.vertices[j] = base + local;
          }

          // Wall Collisions
          let wallHit = false;
          if (b.x - b.radius < 0) { const imp = Math.abs(b.vx); b.x = b.radius; b.vx *= -0.9; wallHit = true; applyJellyImpact(b, +1, 0, imp); }
          else if (b.x + b.radius > canvas.width) { const imp = Math.abs(b.vx); b.x = canvas.width - b.radius; b.vx *= -0.9; wallHit = true; applyJellyImpact(b, -1, 0, imp); }

          if (b.y - b.radius < 0) { const imp = Math.abs(b.vy); b.y = b.radius; b.vy *= -0.9; wallHit = true; applyJellyImpact(b, 0, +1, imp); }
          else if (b.y + b.radius > canvas.height) { const imp = Math.abs(b.vy); b.y = canvas.height - b.radius; b.vy *= gravity > 0.5 ? -0.6 : -0.9; wallHit = true; applyJellyImpact(b, 0, -1, imp); }

          if (b.z < 0) { b.z = 0; b.vz *= -0.9; wallHit = true; }
          else if (b.z > DEPTH) { b.z = DEPTH; b.vz *= -0.9; wallHit = true; }

          if (wallHit) registerDigitImpact(b, nowMs);
          if (wallHit && blackHole < 0.5) {
            if ((Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.vz)) > 0.5) triggerBubbleSound(b, 'WALL');
          }

          // Budding (unchanged behaviour, but safer spawn offset against dist=0)
          const effectiveBudding = perfRef.current.recovering ? 0 : buddingChance;
          if (Math.random() < effectiveBudding * 0.05 && b.radius > 15) {
            b.radius *= 0.8;
            spawnBubble(
              b.x + (Math.random() - 0.5) * 6,
              b.y + (Math.random() - 0.5) * 6,
              b.z + (Math.random() - 0.5) * 12,
              b.radius
            );
          }

          updateJelly(b, tempo);

          // Spaghettification (tidal stretching) near the event horizon: stretch radial, squeeze tangential.
          if (blackHoleEff > 0.001) {
            const dx = cx - b.x;
            const dy = cy - b.y;
            const rSq = dx * dx + dy * dy;
            const r = Math.sqrt(Math.max(EPS, rSq));
            const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
            const r2d = r * scale;

            const tidal = (blackHoleEff * blackHoleEff) / (1 + Math.pow(r2d / 140, 3));
            if (tidal > 0.002) {
              const targetRot = Math.atan2(dy, dx);
              const blend = Math.min(1, tidal * 1.25);
              const curRot = b.deformation.rotation;
              const delta = Math.atan2(Math.sin(targetRot - curRot), Math.cos(targetRot - curRot));

              b.deformation.rotation = curRot + delta * blend;
              b.deformation.scaleX = Math.max(0.35, Math.min(3.0, b.deformation.scaleX * (1 + tidal * 1.6)));
              b.deformation.scaleY = Math.max(0.35, Math.min(3.0, b.deformation.scaleY * (1 - tidal * 0.7)));
            }
          }
          clampBubble(b, tempo);
        }

        // --- MAGNETO (pairwise, symmetric, clamped) ---
        const safeMagneto = Number.isFinite(magneto) ? magneto : 0.5;
        if (Math.abs(safeMagneto - 0.5) > 0.01) {
          const magIntensity = (safeMagneto - 0.5) * 2; // [-1..1]
          const magAbs = Math.abs(magIntensity);

          for (let i = 0; i < bubbles.length; i++) {
            for (let j = i + 1; j < bubbles.length; j++) {
              const b1 = bubbles[i];
              const b2 = bubbles[j];

              const dx = b2.x - b1.x;
              const dy = b2.y - b1.y;
              const dz = b2.z - b1.z;
              const distSq = dx * dx + dy * dy + dz * dz;

              if (distSq < MAG_MIN_DIST_SQ || distSq > MAG_MAX_DIST_SQ) continue;

              const dist = Math.sqrt(Math.max(EPS, distSq));
              const nx = dx / dist; const ny = dy / dist; const nz = dz / dist;

              // base force scaled by distance and knob intensity
              let baseForce = (200 * MAGNETO_BOOST * magAbs) / distSq;

              // charge interaction preference (keep your "feel")
              const chargeFactor = b1.charge * b2.charge;

              // magIntensity > 0: "attract opposites stronger"
              // magIntensity < 0: "repel likes stronger"
              let desire: number;
              if (magIntensity > 0) {
                desire = (chargeFactor < 0) ? +1.5 : -0.5;
              } else {
                desire = (chargeFactor > 0) ? +1.5 : -0.5;
              }

              let force = baseForce * desire;

              // clamp accel per pair
              const maxA = MAX_ACCEL * Math.max(0.2, tempo) * (0.9 + magAbs * 2.2);
              if (force > maxA) force = maxA;
              if (force < -maxA) force = -maxA;

              // apply symmetrically (action-reaction)
              b1.vx += nx * force; b1.vy += ny * force; b1.vz += nz * force;
              b2.vx -= nx * force; b2.vy -= ny * force; b2.vz -= nz * force;
            }
          }

          // clamp after magneto
          for (let i = 0; i < bubbles.length; i++) clampBubble(bubbles[i], tempo);
        }

        // --- COLLISIONS ---
        const topPairs = topPairsRef.current;
        topPairs[0].b1 = null; topPairs[0].b2 = null; topPairs[0].dist = Infinity;
        topPairs[1].b1 = null; topPairs[1].b2 = null; topPairs[1].dist = Infinity;
        topPairs[2].b1 = null; topPairs[2].b2 = null; topPairs[2].dist = Infinity;
        for (let i = 0; i < bubbles.length; i++) {
          for (let j = i + 1; j < bubbles.length; j++) {
            const b1 = bubbles[i]; const b2 = bubbles[j];
            const dx = b2.x - b1.x; const dy = b2.y - b1.y; const dz = b2.z - b1.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const minDist = b1.radius + b2.radius;

            const dist = Math.sqrt(Math.max(EPS, distSq));
            if (dist < minDist * 3) {
              b1.overlapFrame = frameId;
              b2.overlapFrame = frameId;
              const p0 = topPairs[0];
              const p1 = topPairs[1];
              const p2 = topPairs[2];
              if (dist < p0.dist) {
                p2.b1 = p1.b1; p2.b2 = p1.b2; p2.dist = p1.dist;
                p1.b1 = p0.b1; p1.b2 = p0.b2; p1.dist = p0.dist;
                p0.b1 = b1; p0.b2 = b2; p0.dist = dist;
              } else if (dist < p1.dist) {
                p2.b1 = p1.b1; p2.b2 = p1.b2; p2.dist = p1.dist;
                p1.b1 = b1; p1.b2 = b2; p1.dist = dist;
              } else if (dist < p2.dist) {
                p2.b1 = b1; p2.b2 = b2; p2.dist = dist;
              }
            }

            if (dist < minDist) {
              if (Math.random() < cannibalism) {
                if (b1.radius > 0 && b2.radius > 0) {
                  if (b1.radius > b2.radius) {
                    b1.radius = Math.pow(Math.pow(b1.radius, 3) + Math.pow(b2.radius, 3), 1 / 3);
                    b2.radius = 0;
                  } else {
                    b2.radius = Math.pow(Math.pow(b1.radius, 3) + Math.pow(b2.radius, 3), 1 / 3);
                    b1.radius = 0;
                  }
                  triggerBubbleSound(b1, 'ABSORB');
                }
              } else {
                // normal (safe when dist ~ 0)
                let nx = dx / dist; let ny = dy / dist; let nz = dz / dist;
                if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
                  // random fallback normal
                  const ax = (Math.random() - 0.5);
                  const ay = (Math.random() - 0.5);
                  const az = (Math.random() - 0.5);
                  const al = Math.sqrt(Math.max(EPS, ax * ax + ay * ay + az * az));
                  nx = ax / al; ny = ay / al; nz = az / al;
                }

                const rvx = b2.vx - b1.vx; const rvy = b2.vy - b1.vy; const rvz = b2.vz - b1.vz;
                const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;

                if (velAlongNormal < 0) {
                  const jImp = -(1.95) * velAlongNormal / (1 / b1.radius + 1 / b2.radius);
                  const im1 = 1 / b1.radius; const im2 = 1 / b2.radius;
                  b1.vx -= (jImp * nx) * im1; b1.vy -= (jImp * ny) * im1; b1.vz -= (jImp * nz) * im1;
                  b2.vx += (jImp * nx) * im2; b2.vy += (jImp * ny) * im2; b2.vz += (jImp * nz) * im2;

                  const overlap = minDist - dist;
                  b1.x -= nx * overlap * 0.5; b1.y -= ny * overlap * 0.5; b1.z -= nz * overlap * 0.5;
                  b2.x += nx * overlap * 0.5; b2.y += ny * overlap * 0.5; b2.z += nz * overlap * 0.5;

                  const impulse = Math.min(20, -velAlongNormal) + overlap * 0.25;
                  applyJellyImpact(b1, -nx, -ny, impulse);
                  applyJellyImpact(b2, nx, ny, impulse);

                  triggerBubbleSound(b1, 'COLLIDE');
                  registerDigitImpact(b1, nowMs);
                  registerDigitImpact(b2, nowMs);
                }
              }
            }
          }
        }

        // Draw
        bubbles.sort((a, b) => b.z - a.z);
        drawWallReflections(ctx, bubbles, canvas.width, canvas.height, phys.geometryWarp, phys.roomWave, time);
        bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, (b.z / DEPTH) * 6, b.overlapFrame === frameId, nowMs));

        drawHUD(ctx, topPairs, canvas.width, canvas.height);
        drawSpatialGyro(ctx, canvas.width, canvas.height, time);

        requestRef.current = requestAnimationFrame(animate);
      };

      requestRef.current = requestAnimationFrame(animate);

      const handleResize = () => {
        if (containerRef.current && canvasRef.current) {
          canvasRef.current.width = containerRef.current.clientWidth;
          canvasRef.current.height = containerRef.current.clientHeight;
          resetCachesForSize();
        }
      };

      window.addEventListener('resize', handleResize);
      return () => {
        window.removeEventListener('resize', handleResize);
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={containerRef}
        className="w-full h-96 md:h-[500px] bg-[#2E2F2B] rounded-lg shadow-2xl overflow-hidden relative border border-[#5F665F] cursor-crosshair perspective-container select-none"
      >
        <canvas
          ref={canvasRef}
          className="block w-full h-full touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>
    );
  }
);
