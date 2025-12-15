import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Bubble, PhysicsSettings, AudioSettings, Particle } from '../types';
import { audioService } from '../services/audioEngine';
import { v4 as uuidv4 } from 'uuid';

interface VisualizerProps {
  isPlaying: boolean;
  physics: PhysicsSettings;
  audioSettings: AudioSettings;
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

type BubbleExt = Bubble & {
  lastAudioAt?: number;
};

export const Visualizer = forwardRef<VisualizerHandle, VisualizerProps>(
  ({ isPlaying, physics, audioSettings }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const physicsRef = useRef<PhysicsSettings>(physics);
    const audioSettingsRef = useRef<AudioSettings>(audioSettings);
    const bubblesRef = useRef<BubbleExt[]>([]);
    const particlesRef = useRef<Particle[]>([]);
    const requestRef = useRef<number | null>(null);
    const isPlayingRef = useRef<boolean>(isPlaying);

    // Matrix Log Buffer
    const logRef = useRef<string[]>([]);

    // Drawing State
    const isDrawingRef = useRef(false);
    const lastSpawnPos = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => { physicsRef.current = physics; }, [physics]);
    useEffect(() => { audioSettingsRef.current = audioSettings; }, [audioSettings]);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

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
        lastAudioAt: 0,
      });

      pushLog(`SPAWN: ${id} <R:${Math.round(radius)}>`);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      isDrawingRef.current = true;
      lastSpawnPos.current = { x, y };
      spawnBubble(x, y, 50);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDrawingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

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

    const handleMouseUp = () => {
      isDrawingRef.current = false;
      lastSpawnPos.current = null;
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
        phys.toneMatch
      );

      if (Math.random() > 0.85) {
        pushLog(`AUDIO: ${triggerType} [${b.id}]`);
      }
    };

    // --- DRAWING FUNCTIONS ---

    const drawMatrixLog = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.save();
      ctx.font = '10px "Courier New", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      // Background Noise (Hex Grid)
      ctx.save();
      ctx.font = '10px "Courier New", monospace';
      ctx.fillStyle = 'rgba(122, 132, 118, 0.08)';
      for (let i = 20; i < w; i += 120) {
        for (let j = 20; j < h; j += 40) {
          if (Math.random() > 0.95) {
            const hex = `0x${Math.floor(Math.random() * 16777215).toString(16).toUpperCase()}`;
            ctx.fillText(hex, i, j);
          }
        }
      }
      ctx.restore();

      // Log Entries
      ctx.fillStyle = '#7A8476';
      let y = h - 20;
      for (let i = logRef.current.length - 1; i >= 0; i--) {
        ctx.fillText(logRef.current[i], 15, y);
        y -= 12;
      }

      // System Params (Top Right)
      const phys = physicsRef.current;
      const audio = audioSettingsRef.current;

      let scaleName = 'CHROMATIC';
      if (phys.toneMatch > 0.8) scaleName = 'MAJ_PENTA';
      else if (phys.toneMatch > 0.6) scaleName = 'MIN_PENTA';
      else if (phys.toneMatch > 0.4) scaleName = 'DORIAN_MODE';
      else if (phys.toneMatch > 0.2) scaleName = 'LYDIAN_MODE';

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
        `SCALE_MODE: ${scaleName}`,
        `VERB_MIX  : ${audio.reverbWet.toFixed(2)}`,
        `ECHO_FDBK : ${phys.pingPong.toFixed(2)}`,
        `REV_PROB  : ${phys.reverseChance.toFixed(2)}`,
        `// SYSTEM`,
        `ACTIVE_OBJ: ${bubblesRef.current.length}`,
        `HEAP_SIZE : ${(bubblesRef.current.length * 0.45).toFixed(2)}KB`,
      ];

      y = 15;
      ctx.textAlign = 'right';

      params.forEach(p => {
        if (p.startsWith('//')) ctx.fillStyle = '#5F665F';
        else ctx.fillStyle = '#7A8476';
        ctx.fillText(p, w - 15, y);
        y += 12;
      });

      ctx.restore();
    };

    const drawAmoeba = (ctx: CanvasRenderingContext2D, b: BubbleExt, w: number, h: number, blurAmount: number) => {
      const scale = FOCAL_LENGTH / (FOCAL_LENGTH + b.z);
      const cx = w / 2; const cy = h / 2;
      const x2d = (b.x - cx) * scale + cx;
      const y2d = (b.y - cy) * scale + cy;
      const r2d = b.radius * scale;

      if (r2d < 1) return;

      ctx.save();
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
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.stroke();

      if (b.radius > 40) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.id, 0, 0);
      }

      ctx.restore();
    };

    const drawRoom = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
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

      const fTL = { x: 0, y: 0, z: 0 };
      const fTR = { x: w, y: 0, z: 0 };
      const fBR = { x: w, y: h, z: 0 };
      const fBL = { x: 0, y: h, z: 0 };

      const bTL = { x: -w * 0.1, y: -h * 0.1, z: DEPTH };
      const bTR = { x: w * 1.2, y: -h * 0.05, z: DEPTH * 0.9 };
      const bBR = { x: w * 0.9, y: h * 1.1, z: DEPTH };
      const bBL = { x: -w * 0.05, y: h * 1.05, z: DEPTH * 1.1 };

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

        const info = `[X:${Math.round((b1.x + b2.x) / 2)} Y:${Math.round((b1.y + b2.y) / 2)} Z:${Math.round((b1.z + b2.z) / 2)}]`;

        const textWidth = ctx.measureText(info).width;
        ctx.fillStyle = 'rgba(242, 242, 240, 0.8)';
        ctx.fillRect(mx - textWidth / 2 - 2, my - 14, textWidth + 4, 12);

        ctx.fillStyle = '#2E2F2B';
        ctx.fillText(info, mx, my - 8);
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

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#2E2F2B';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const gradientBack = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradientBack.addColorStop(0, '#2E2F2B');
        gradientBack.addColorStop(1, '#3F453F');
        ctx.fillStyle = gradientBack;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        drawMatrixLog(ctx, canvas.width, canvas.height);
        drawRoom(ctx, canvas.width, canvas.height);

        const phys = physicsRef.current;
        const bubbles = bubblesRef.current;
        const particles = particlesRef.current;

        if (!isPlayingRef.current) {
          bubbles.sort((a, b) => b.z - a.z);
          bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, 0));
          requestRef.current = requestAnimationFrame(animate);
          return;
        }

        const { tempo, gravity, buddingChance, cannibalism, wind, blackHole, weakness, magneto, fragmentation, freeze } = phys;
        const time = Date.now() * 0.002 * tempo;
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

          // Elasticity
          const elasticity = 0.25 + (0.25 * (1 - freeze));
          for (let j = 0; j < VERTEX_COUNT; j++) {
            b.vertices[j] = 1 + (
              Math.sin(time * 1.5 + b.vertexPhases[j]) * elasticity * 0.6 +
              Math.sin(time * 0.8 + j) * elasticity * 0.4
            );
          }

          // Wall Collisions
          let wallHit = false;
          if (b.x - b.radius < 0) { b.x = b.radius; b.vx *= -0.9; wallHit = true; }
          else if (b.x + b.radius > canvas.width) { b.x = canvas.width - b.radius; b.vx *= -0.9; wallHit = true; }

          if (b.y - b.radius < 0) { b.y = b.radius; b.vy *= -0.9; wallHit = true; }
          else if (b.y + b.radius > canvas.height) { b.y = canvas.height - b.radius; b.vy *= gravity > 0.5 ? -0.6 : -0.9; wallHit = true; }

          if (b.z < 0) { b.z = 0; b.vz *= -0.9; wallHit = true; }
          else if (b.z > DEPTH) { b.z = DEPTH; b.vz *= -0.9; wallHit = true; }

          if (wallHit && blackHole < 0.5) {
            if ((Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.vz)) > 0.5) triggerBubbleSound(b, 'WALL');
          }

          // Budding (unchanged behaviour, but safer spawn offset against dist=0)
          if (Math.random() < buddingChance * 0.05 && b.radius > 15) {
            b.radius *= 0.8;
            spawnBubble(
              b.x + (Math.random() - 0.5) * 6,
              b.y + (Math.random() - 0.5) * 6,
              b.z + (Math.random() - 0.5) * 12,
              b.radius
            );
          }

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

                  triggerBubbleSound(b1, 'COLLIDE');
                }
              }
            }
          }
        }

        // Draw
        bubbles.sort((a, b) => b.z - a.z);
        bubbles.forEach(b => drawAmoeba(ctx, b, canvas.width, canvas.height, (b.z / DEPTH) * 6));

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
          className="block w-full h-full"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>
    );
  }
);
