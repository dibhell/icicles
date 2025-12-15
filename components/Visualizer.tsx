import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { AudioSettings, PhysicsSettings } from '../types';

export interface VisualizerHandle {
  reset: () => void;
}

interface Bubble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  energy: number;
  lastBudding: number;
}

interface Props {
  isPlaying: boolean;
  physics: PhysicsSettings;
  audioSettings: AudioSettings;
}

/* =======================
   TUNABLE CONSTANTS
======================= */

const MAX_BUBBLES = 180;          // mobile safe
const BUDDING_COOLDOWN = 1600;    // ms
const ENERGY_THRESHOLD = 0.6;

const MAX_VELOCITY = 5;

const MERGE_RADIUS = 14;
const MERGE_PROBABILITY = 0.2;    // per frame

/* =======================
   VISUALIZER
======================= */

export const Visualizer = forwardRef<VisualizerHandle, Props>(
  ({ isPlaying, physics }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const bubblesRef = useRef<Bubble[]>([]);
    const rafRef = useRef<number | null>(null);

    /* ---------- EXPOSE RESET ---------- */
    useImperativeHandle(ref, () => ({
      reset() {
        bubblesRef.current = [];
      },
    }));

    /* ---------- RESIZE (DPR SAFE) ---------- */
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    /* ---------- SPAWN ---------- */
    const spawnBubble = (parent?: Bubble) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (bubblesRef.current.length >= MAX_BUBBLES) return;

      bubblesRef.current.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        r: parent ? parent.r * 0.75 : 6 + Math.random() * 4,
        energy: parent ? parent.energy * 0.5 : Math.random(),
        lastBudding: performance.now(),
      });
    };

    /* ---------- HUD LABEL (GLASS) ---------- */
    const drawHudLabel = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      text: string
    ) => {
      ctx.save();

      ctx.font = '11px monospace';
      const padding = 6;
      const w = ctx.measureText(text).width + padding * 2;
      const h = 18;

      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#1f1f1f';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h - 10, w, h, 6);
      ctx.fill();

      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#E6E6E6';
      ctx.fillText(text, x - w / 2 + padding, y - 10);

      ctx.restore();
    };

    /* ---------- MAIN LOOP ---------- */
    const step = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      const bubbles = bubblesRef.current;
      const now = performance.now();

      ctx.clearRect(0, 0, w, h);

      /* ----- UPDATE & DRAW ----- */
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];

        // Physics
        b.vy += physics.gravity * 0.05;
        b.vx += physics.wind * 0.03;

        // Clamp velocity
        b.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, b.vx));
        b.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, b.vy));

        if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy)) {
          b.vx = b.vy = 0;
        }

        b.x += b.vx;
        b.y += b.vy;

        // Bounce
        if (b.x < b.r || b.x > w - b.r) b.vx *= -0.8;
        if (b.y < b.r || b.y > h - b.r) b.vy *= -0.8;

        /* ----- BUDDING (CONTROLLED) ----- */
        if (
          physics.budding > 0 &&
          b.energy > ENERGY_THRESHOLD &&
          now - b.lastBudding > BUDDING_COOLDOWN &&
          Math.random() < physics.budding * 0.01
        ) {
          b.lastBudding = now;
          spawnBubble(b);
        }

        /* ----- DRAW BUBBLE ----- */
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(122,132,118,0.7)';
        ctx.fill();

        /* ----- HUD ----- */
        const magnetoSign =
          physics.magneto > 0.55
            ? '+'
            : physics.magneto < 0.45
            ? '−'
            : '±';

        drawHudLabel(
          ctx,
          b.x,
          b.y,
          `x:${b.x | 0} y:${b.y | 0} z:${b.energy.toFixed(2)} ${magnetoSign}`
        );
      }

      /* ----- MERGE (LIMITED) ----- */
      if (physics.cannibalism > 0 && Math.random() < MERGE_PROBABILITY) {
        for (let i = 0; i < bubbles.length; i++) {
          const a = bubbles[i];
          if (!a) continue;

          for (let j = i + 1; j < bubbles.length; j++) {
            const b = bubbles[j];
            if (!b) continue;

            const dx = a.x - b.x;
            const dy = a.y - b.y;

            if (Math.abs(dx) > MERGE_RADIUS || Math.abs(dy) > MERGE_RADIUS)
              continue;

            const dist = Math.hypot(dx, dy);
            if (dist > MERGE_RADIUS) continue;

            a.r = Math.min(a.r + b.r * 0.4, 20);
            a.energy = Math.min(1, a.energy + b.energy * 0.3);
            bubbles.splice(j, 1);
            break;
          }
        }
      }

      rafRef.current = requestAnimationFrame(step);
    };

    /* ---------- EFFECTS ---------- */
    useEffect(() => {
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, []);

    useEffect(() => {
      if (isPlaying) {
        if (bubblesRef.current.length === 0) {
          for (let i = 0; i < 20; i++) spawnBubble();
        }
        rafRef.current = requestAnimationFrame(step);
      } else if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }

      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, physics]);

    return (
      <canvas
        ref={canvasRef}
        className="w-full h-full rounded-xl bg-[#F2F2F0]"
      />
    );
  }
);

Visualizer.displayName = 'Visualizer';
