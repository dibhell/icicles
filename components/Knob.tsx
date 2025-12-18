import React, { useEffect, useMemo, useRef } from 'react';

type KnobProps = {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  defaultValue?: number;
  steps?: number;
  sensitivity?: number;      // default 0.004
  fineSensitivity?: number;  // default 0.0015
  disabled?: boolean;
  className?: string;
  label?: string;
  format?: (v: number) => string;
  color?: string;
  size?: number;
};

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const snap01 = (t: number, steps?: number) => {
  if (!steps || steps <= 1) return t;
  const k = steps - 1;
  return Math.round(t * k) / k;
};

export function Knob({
  value,
  onChange,
  min = 0,
  max = 1,
  defaultValue = 0,
  steps,
  sensitivity = 0.004,
  fineSensitivity = 0.0015,
  disabled,
  className = '',
  label,
  format,
  color = '#7A8476',
  size = 48,
}: KnobProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const state = useRef({
    pointerId: -1,
    startY: 0,
    startX: 0,
    start01: 0,
    moved: false,
    lastTapUpAt: 0,
    lastTapUpX: 0,
    lastTapUpY: 0,
  });
  const cleanup = useRef<null | (() => void)>(null);

  const to01 = (v: number) => (v - min) / (max - min || 1);
  const from01 = (t: number) => min + t * (max - min);
  const set01 = (t01: number) => onChange(from01(snap01(clamp(t01, 0, 1), steps)));

  const norm = useMemo(() => clamp((value - min) / (max - min || 1), 0, 1), [value, min, max]);

  const BASE_START_DEG = 135; // left-top quadrant for symmetric arc
  const START_OFFSET_DEG = 0; // tweak if ever needed
  const startDeg = BASE_START_DEG + START_OFFSET_DEG;
  const sweepDeg = 270; // classic knob arc, mid at top (start + sweep/2 = 270)
  const cw = true;

  const angleDegFromValue = (t: number) => {
    const v = clamp(t, 0, 1);
    return cw ? startDeg + v * sweepDeg : startDeg - v * sweepDeg;
  };
  const angleDeg = angleDegFromValue(norm);

  const strokeWidth = size * 0.11; // slightly thicker for better readability
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - strokeWidth;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const polar = (deg: number) => {
    const rad = toRad(deg);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const endDeg = cw ? startDeg + sweepDeg : startDeg - sweepDeg;
  const trackStart = polar(startDeg);
  const trackEnd = polar(endDeg);
  const trackLargeArc = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const trackPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${trackLargeArc} ${cw ? 1 : 0} ${trackEnd.x} ${trackEnd.y}`;

  const DRAG_THRESHOLD_PX = 4;
  const DOUBLE_TAP_MS = 320;
  const DOUBLE_TAP_DIST = 18;

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    state.current.pointerId = e.pointerId;
    state.current.startY = e.clientY;
    state.current.startX = e.clientX;
    state.current.start01 = to01(value);
    state.current.moved = false;
    ref.current?.classList.add('is-pressing');
    try { ref.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== state.current.pointerId) return;
      ev.preventDefault();
      const dy = state.current.startY - ev.clientY;
      const dx = state.current.startX - ev.clientX;
      if (!state.current.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        state.current.moved = true;
        ref.current?.classList.add('is-dragging');
        ref.current?.classList.remove('is-pressing');
      }
      const fine = (ev as any).shiftKey === true;
      const sens = fine ? fineSensitivity : sensitivity;
      set01(state.current.start01 + dy * sens);
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== state.current.pointerId) return;
      ev.preventDefault();

      const wasDrag = state.current.moved;
      ref.current?.classList.remove('is-dragging');
      ref.current?.classList.remove('is-pressing');

      if (!wasDrag) {
        const now = performance.now();
        const dt = now - state.current.lastTapUpAt;
        const dist = Math.hypot(ev.clientX - state.current.lastTapUpX, ev.clientY - state.current.lastTapUpY);
        const isDouble = dt < DOUBLE_TAP_MS && dist < DOUBLE_TAP_DIST;
        if (isDouble) {
          set01(to01(defaultValue));
          state.current.lastTapUpAt = 0;
        } else {
          state.current.lastTapUpAt = now;
          state.current.lastTapUpX = ev.clientX;
          state.current.lastTapUpY = ev.clientY;
        }
      }

      state.current.pointerId = -1;
      try { ref.current?.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      cleanup.current?.();
      cleanup.current = null;
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { passive: false });
    window.addEventListener('pointercancel', up, { passive: false });
    cleanup.current = () => {
      window.removeEventListener('pointermove', move as any);
      window.removeEventListener('pointerup', up as any);
      window.removeEventListener('pointercancel', up as any);
    };
  };

  useEffect(() => () => cleanup.current?.(), []);

  return (
    <div
      ref={ref}
      className={`flex flex-col items-center gap-1 select-none touch-none ${className}`}
      style={{
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        pointerEvents: 'auto',
      }}
      onPointerDown={onPointerDown}
    >
      <div className="relative cursor-ns-resize group touch-none" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="drop-shadow-sm pointer-events-none">
          <path
            d={trackPath}
            fill="none"
            stroke="#D9DBD6"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          {/* Progress uses the same path; dashoffset reveals from the start */}
          <path
            d={trackPath}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            ref={(node) => {
              if (!node) return;
              const L = node.getTotalLength();
              const filled = norm * L;
              node.style.strokeDasharray = `${L} ${L}`;
              node.style.strokeDashoffset = `${L - filled}`;
              node.style.opacity = '0.9';
            }}
          />
          {/* Pointer drawn in the same coordinate system */}
          {(() => {
            const angle = toRad(angleDeg);
            const px = cx + r * Math.cos(angle);
            const py = cy + r * Math.sin(angle);
            const innerR = r - strokeWidth * 1.1; // extend inward
            const outerR = r + strokeWidth * 0.4; // extend outward
            const lx1 = cx + innerR * Math.cos(angle);
            const ly1 = cy + innerR * Math.sin(angle);
            const lx2 = cx + outerR * Math.cos(angle);
            const ly2 = cy + outerR * Math.sin(angle);
            const w = Math.max(1.6, strokeWidth * 0.26); // thicker pointer
            const pointerColor = color ?? '#7A8476';
            return (
              <>
                <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} stroke={pointerColor} strokeWidth={w} strokeLinecap="round" />
                <circle cx={px} cy={py} r={w * 0.75} fill={pointerColor} />
              </>
            );
          })()}
        </svg>
      </div>
      <div className="flex flex-col items-center pointer-events-none mt-1">
        {label && <span className="text-[9px] font-bold text-[#7A8476] uppercase tracking-wider leading-none mb-0.5 opacity-80">{label}</span>}
        <span className="text-[10px] font-mono font-bold leading-none">{format ? format(value) : value.toFixed(2)}</span>
      </div>
    </div>
  );
}
