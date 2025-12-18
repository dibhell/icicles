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

type JellyState = {
  sx: number; sy: number; rot: number;
  vsx: number; vsy: number; vrot: number;
  vOff: number[];
  vVel: number[];
  nx2: number; ny2: number;
};

type BubbleExt = Bubble & {
  lastAudioAt?: number;
  jelly?: JellyState;
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
    const perfRef = useRef({ recovering: false, lockUntilHighFps: false });
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

    // Matrix Log Buffer
    const logRef = useRef<string[]>([]);

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
        bubblesRef.current = [];
        particlesRef.current = [];
        logRef.current = [];
      },
    }));

    const pushLog = (msg: string) => {
      const ts = new Date().toISOString().split('T')[1].split('.')[0];
      const line = `[${ts}] ${msg}`;
      logRef.current.push(line);
      if (logRef.current.length > 16) logRef.current.shift();
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
      particlesRef.current.push({
        x, y, z,
        vx: (Math.random() - 0.5) * 15,
        vy: (Math.random() - 0.5) * 15,
        vz: (Math.random() - 0.5) * 15,
        life: 1.0,
        color,
        size: Math.random() * 2 + 0.5,
      });
    };

    const spawnBubble = (x: number, y: number, z: number = 0, r?: number) => {
      const variants = [
        'hsla(60, 5%, 95%, 1)',   // Snow White
        'hsla(180, 10%, 85%, 1)', // Icy Grey
        'hsla(100, 10%, 80%, 1)', // Pale Moss
        'hsla(200, 15%, 90%, 1)', // Cold Blue
      ];
      const color = variants[Math.floor(Math.random() * variants.length)];
      const radius = r || Math.random() * 35 + 15;
      const jelly: JellyState = {
        sx: 1, sy: 1, rot: 0,
        vsx: 0, vsy: 0, vrot: 0,
        vOff: new Array(VERTEX_COUNT).fill(0),
        vVel: new Array(VERTEX_COUNT).fill(0),
        nx2: 1, ny2: 0,
      };

      const vertices = new Array(VERTEX_COUNT).fill(1);
      const vertexPhases = new Array(VERTEX_COUNT).fill(0).map(() => Math.random() * Math.PI * 2);
      const charge = Math.random() > 0.5 ? 1 : -1;
      const id = uuidv4().substring(0, 6).toUpperCase();

      bubblesRef.current.push({
        id,
        x, y, z: z || Math.random() * (DEPTH * 0.5),
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        vz: (Math.random() - 0.5) * 2,
        radius,
        color,
        hue: 0,
        charge,
        vertices,
        vertexPhases,
        deformation: { scaleX: 1, scaleY: 1, rotation: 0 },
        jelly,
        lastAudioAt: 0,
      });

      pushLog(`SPAWN: ${id} <R:${Math.round(radius)}>`);
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
        musicSettingsRef.current
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
      ctx.fillStyle = 'rgba(200, 210, 205, 0.85)';
      let y = h - 20;
      for (let i = logRef.current.length - 1; i >= 0; i--) {
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

      const params = [
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

    const drawAmoeba = (ctx: CanvasRenderingContext2D, b: BubbleExt, w: number, h: number, blurAmount: number, overlap: boolean) => {
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

      ctx.beginPath();
      const angleStep = (Math.PI * 2) / VERTEX_COUNT;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < VERTEX_COUNT; i++) {
        const r = r2d * b.vertices[i];
        const a = i * angleStep;
        points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }

      const mid = (p1: any, p2: any) => ({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
      const start = mid(points[points.length - 1], points[0]);
      ctx.moveTo(start.x, start.y);
      for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        const m = mid(p1, p2);
        ctx.quadraticCurveTo(p1.x, p1.y, m.x, m.y);
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

      if (b.radius > 40) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.id, 0, 0);
      }

      ctx.restore();
    };

    const drawRoom = (ctx: CanvasRenderingContext2D, w: number, h: number, warp: number, wave: number, time: number) => {
      ctx.save();
      ctx.strokeStyle = '#B9BCB7';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);

      const project = (x: number, y: number, z: number) => {
        const scale = FOCAL_LENGTH / (FOCAL_LENGTH + z);
        return {
          x: (x - w / 2) * scale + w / 2,
          y: (y - h / 2) * scale + h / 2,
        };
      };

      const warpAmt = warp * 0.35;
      const waveScale = wave * 0.35; // 65% softer
      const waveAmt = waveScale * 0.25;
      const wavePhase = time * 0.6;

      const warpOffset = (ix: number, iy: number, iz: number) => {
        const dx = (Math.sin(wavePhase + ix * 0.5 + iy * 0.3) + 1) * 0.5;
        const dy = (Math.cos(wavePhase * 0.7 + ix * 0.2 + iy * 0.6) + 1) * 0.5;
        return {
          x: (dx - 0.5) * warpAmt * w,
          y: (dy - 0.5) * warpAmt * h,
          z: (Math.sin(wavePhase + iz) + 1) * 0.5 * warpAmt * DEPTH * 0.3,
        };
      };

      const baseFront = [
        { x: 0, y: 0, z: 0 },
        { x: w, y: 0, z: 0 },
        { x: w, y: h, z: 0 },
        { x: 0, y: h, z: 0 },
      ];
      const baseBack = [
        { x: -w * 0.1, y: -h * 0.1, z: DEPTH },
        { x: w * 1.2, y: -h * 0.05, z: DEPTH * 0.9 },
        { x: w * 0.9, y: h * 1.1, z: DEPTH },
        { x: -w * 0.05, y: h * 1.05, z: DEPTH * 1.1 },
      ];

      const fTL = baseFront[0];
      const fTR = baseFront[1];
      const fBR = baseFront[2];
      const fBL = baseFront[3];

      const bTL = baseBack[0];
      const bTR = baseBack[1];
      const bBR = baseBack[2];
      const bBL = baseBack[3];

      [fTL, fTR, fBR, fBL].forEach((p, idx) => {
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.6) : 0;
        p.x += (idx === 0 ? -1 : idx === 1 ? 1 : 0) * warpAmt * w * 0.2;
        p.y += (idx === 0 ? -1 : idx === 3 ? 1 : 0) * warpAmt * h * 0.15;
        p.z += wv * DEPTH * 0.1;
      });
      [bTL, bTR, bBR, bBL].forEach((p, idx) => {
        const offs = warpOffset(idx, idx * 0.3, idx * 0.5);
        const wv = wave > 0 ? waveAmt * Math.sin(wavePhase + idx * 0.8 + 1.2) : 0;
        p.x += offs.x;
        p.y += offs.y;
        p.z += offs.z + wv * DEPTH * 0.2;
      });

      ctx.strokeStyle = 'rgba(185, 188, 183, 0.15)';
      const gridSteps = 5;
      for (let i = 0; i <= gridSteps; i++) {
        const t = i / gridSteps;
        const p1 = project(fBL.x + (fBR.x - fBL.x) * t, fBL.y + (fBR.y - fBL.y) * t, fBL.z);
        const p2 = project(bBL.x + (bBR.x - bBL.x) * t, bBL.y + (bBR.y - bBL.y) * t, bBL.z);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(185, 188, 183, 0.4)';
      const pfTL = project(fTL.x, fTL.y, fTL.z); const pbTL = project(bTL.x, bTL.y, bTL.z);
      const pfTR = project(fTR.x, fTR.y, fTR.z); const pbTR = project(bTR.x, bTR.y, bTR.z);
      const pfBR = project(fBR.x, fBR.y, fBR.z); const pbBR = project(bBR.x, bBR.y, bBR.z);
      const pfBL = project(fBL.x, fBL.y, fBL.z); const pbBL = project(bBL.x, bBL.y, bBL.z);

      ctx.beginPath(); ctx.moveTo(pfTL.x, pfTL.y); ctx.lineTo(pbTL.x, pbTL.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfTR.x, pfTR.y); ctx.lineTo(pbTR.x, pbTR.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfBR.x, pfBR.y); ctx.lineTo(pbBR.x, pbBR.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pfBL.x, pfBL.y); ctx.lineTo(pbBL.x, pbBL.y); ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(pbTL.x, pbTL.y); ctx.lineTo(pbTR.x, pbTR.y); ctx.lineTo(pbBR.x, pbBR.y); ctx.lineTo(pbBL.x, pbBL.y);
      ctx.closePath(); ctx.stroke();

      ctx.restore();
    };

    const drawHUD = (ctx: CanvasRenderingContext2D, pairs: { b1: BubbleExt; b2: BubbleExt }[], w: number, h: number) => {
      ctx.save();
      ctx.font = '10px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#4A4F4A';

      pairs.forEach(({ b1, b2 }) => {
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
      }

      const animate = () => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
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
          fpsState.fps = 60;
          perfRef.current.recovering = false;
          perfRef.current.lockUntilHighFps = false;
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
        if (fpsState.fps > 55) {
          perf.recovering = false;
          perf.lockUntilHighFps = false;
        } else if (fpsState.fps > 30 && !perf.lockUntilHighFps) {
          perf.recovering = false;
        } else if (fpsState.fps > 0 && fpsState.fps < 30) {
          perf.recovering = true;
          perf.lockUntilHighFps = true;
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#2E2F2B';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const gradientBack = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradientBack.addColorStop(0, '#2E2F2B');
        gradientBack.addColorStop(1, '#3F453F');
        ctx.fillStyle = gradientBack;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const phys = physicsRef.current;
        const audio = audioSettingsRef.current;
        const time = Date.now() * 0.002 * Math.max(0.1, phys.tempo || 0);
        const peakDb = audioService.getPeakLevel();
        drawMatrixLog(ctx, canvas.width, canvas.height, {
          peakDb,
          baseFreq: audio.baseFrequency,
          objects: bubblesRef.current.length,
          fps: fpsRef.current.fps,
        });
        drawRoom(ctx, canvas.width, canvas.height, phys.geometryWarp, phys.roomWave, time);

        const bubbles = bubblesRef.current;
        const particles = particlesRef.current;
        const recovering = perfRef.current.recovering;
        const fpsNow = fpsRef.current.fps;
        const severity = recovering ? Math.max(0, 30 - Math.max(0, fpsNow)) / 30 : 0;
        let shredQuota = 0;
        if (recovering && bubbles.length > 0) {
          // Gradual decay: remove a small fraction per frame based on severity, capped
          shredQuota = Math.max(1, Math.floor(bubbles.length * (0.02 + severity * 0.06)));
          shredQuota = Math.min(shredQuota, Math.max(2, Math.floor(bubbles.length * 0.1)));
        }

        if (!isPlayingRef.current) {
          bubbles.sort((a, b) => b.z - a.z);
          bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, 0));
          requestRef.current = requestAnimationFrame(animate);
          return;
        }

        const { tempo, gravity, buddingChance, cannibalism, wind, blackHole, weakness, magneto, fragmentation, freeze, roomWave } = phys;
        const cx = canvas.width / 2; const cy = canvas.height / 2; const cz = DEPTH / 2;

        // --- PARTICLE LOOP ---
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.x += p.vx * tempo; p.y += p.vy * tempo; p.z += p.vz * tempo;
          p.life -= 0.02 * tempo;
          if (p.life <= 0) { particles.splice(i, 1); i--; continue; }

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

          // Freeze (Viscosity)
          if (freeze > 0) {
            const drag = 1 - (freeze * 0.1 * tempo);
            b.vx *= drag;
            b.vy *= drag;
            b.vz *= drag;
          }

          // Auto shred if perf drops (gradual, not all at once)
          if (recovering && shredQuota > 0 && Math.random() < (0.35 + severity * 0.35)) {
            for (let k = 0; k < 32; k++) spawnParticle(b.x, b.y, b.z, b.color);
            pushLog(`FPS_SHRED: ${b.id}`);
            shredQuota -= 1;
            bubbles.splice(i, 1); i--; continue;
          }

          if (fragmentation > 0 && Math.random() < fragmentation * 0.005) {
            for (let k = 0; k < 32; k++) spawnParticle(b.x, b.y, b.z, b.color);
            pushLog(`ERR_FRAG: ${b.id}`);
            bubbles.splice(i, 1); i--; continue;
          }

          if (weakness > 0) {
            b.radius -= (weakness * 0.1) * tempo;
            if (b.radius < 5) { bubbles.splice(i, 1); i--; continue; }
          }

          if (blackHole > 0.05) {
            const dx = cx - b.x; const dy = cy - b.y; const dz = cz - b.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const dist = Math.sqrt(Math.max(EPS, distSq));
            if (dist < 40 + (blackHole * 20)) { bubbles.splice(i, 1); i--; continue; }
            const force = (blackHole * 5000) / Math.max(1000, distSq);
            const angle = Math.atan2(dy, dx);
            b.vx += (dx / dist) * force + (-Math.sin(angle) * blackHole * 0.5);
            b.vy += (dy / dist) * force + (Math.cos(angle) * blackHole * 0.5);
            b.vz += (dz / dist) * force;
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
          clampBubble(b, tempo);
        }

        // --- MAGNETO (pairwise, symmetric, clamped) ---
        if (Math.abs(magneto - 0.5) > 0.02) {
          const magIntensity = (magneto - 0.5) * 2; // [-1..1]
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
              let baseForce = (200 * magAbs) / distSq;

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
              const maxA = MAX_ACCEL * Math.max(0.2, tempo);
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
        const collisionPairs: { b1: BubbleExt; b2: BubbleExt; dist: number }[] = [];
        for (let i = 0; i < bubbles.length; i++) {
          for (let j = i + 1; j < bubbles.length; j++) {
            const b1 = bubbles[i]; const b2 = bubbles[j];
            const dx = b2.x - b1.x; const dy = b2.y - b1.y; const dz = b2.z - b1.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const minDist = b1.radius + b2.radius;

            const dist = Math.sqrt(Math.max(EPS, distSq));
            if (dist < minDist * 3) collisionPairs.push({ b1, b2, dist });

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
                }
              }
            }
          }
        }

        const overlapIds = new Set<string>();
        collisionPairs.forEach(({ b1, b2 }) => {
          overlapIds.add(b1.id);
          overlapIds.add(b2.id);
        });

        // Draw
        bubbles.sort((a, b) => b.z - a.z);
        bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, (b.z / DEPTH) * 6, overlapIds.has(b.id)));

        const topPairs = collisionPairs.sort((a, b) => a.dist - b.dist).slice(0, 3);
        drawHUD(ctx, topPairs, canvas.width, canvas.height);

        requestRef.current = requestAnimationFrame(animate);
      };

      requestRef.current = requestAnimationFrame(animate);

      const handleResize = () => {
        if (containerRef.current && canvasRef.current) {
          canvasRef.current.width = containerRef.current.clientWidth;
          canvasRef.current.height = containerRef.current.clientHeight;
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
