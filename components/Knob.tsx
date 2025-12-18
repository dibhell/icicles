import React, { useEffect, useMemo, useRef, useState } from 'react';

type KnobProps = {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  defaultValue?: number;
  steps?: number; // e.g. 101 -> snap every 0.01
  sensitivity?: number; // default 0.004 (250px = +1)
  fineSensitivity?: number; // shift held: default 0.0015
  disabled?: boolean;
  className?: string;
  label?: string;
  format?: (v: number) => string;
  color?: string;
  size?: number;
};

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function snap01(x: number, steps?: number) {
  if (!steps || steps <= 1) return x;
  const k = steps - 1;
  return Math.round(x * k) / k;
}

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
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startY: number; startValue: number; pointerId: number | null }>({
    startY: 0,
    startValue: value,
    pointerId: null,
  });

  // Normalized value 0..1
  const norm = useMemo(() => clamp((value - min) / (max - min || 1), 0, 1), [value, min, max]);

  const startDeg = -135;
  const sweepDeg = 270;
  const rotation = startDeg + norm * sweepDeg - 90; // indicator up -> align to start

  // Precompute arc paths
  const strokeWidth = size * 0.1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - strokeWidth;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const polar = (deg: number) => {
    const rad = toRad(deg);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const trackStart = polar(startDeg);
  const trackEnd = polar(startDeg + sweepDeg);
  const trackLargeArc = sweepDeg > 180 ? 1 : 0;
  const trackPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${trackLargeArc} 1 ${trackEnd.x} ${trackEnd.y}`;

  const valueDeg = startDeg + sweepDeg * norm;
  const valueEnd = polar(valueDeg);
  const valueLargeArc = valueDeg - startDeg > 180 ? 1 : 0;
  const valuePath =
    norm <= 0.0001
      ? ''
      : `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${valueLargeArc} 1 ${valueEnd.x} ${valueEnd.y}`;

  const applyDelta = (clientY: number, shiftKey: boolean) => {
    const state = dragState.current;
    const deltaY = state.startY - clientY; // up is positive
    const sens = (shiftKey ? fineSensitivity : sensitivity) * (max - min);
    let next = state.startValue + deltaY * sens;
    next = clamp(next, min, max);
    const snappedNorm = snap01((next - min) / (max - min || 1), steps);
    const snapped = min + snappedNorm * (max - min);
    if (snapped !== value) onChange(snapped);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const node = ref.current;
    if (node) node.setPointerCapture(e.pointerId);
    dragState.current = { startY: e.clientY, startValue: value, pointerId: e.pointerId };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    e.preventDefault();
    applyDelta(e.clientY, e.shiftKey);
  };

  const endDrag = (e: React.PointerEvent) => {
    const node = ref.current;
    if (node && dragState.current.pointerId !== null) {
      try {
        node.releasePointerCapture(dragState.current.pointerId);
      } catch {
        /* ignore */
      }
    }
    dragState.current.pointerId = null;
    setDragging(false);
  };

  const handleDoubleClick = () => {
    const clamped = clamp(defaultValue, min, max);
    onChange(snap01((clamped - min) / (max - min || 1), steps) * (max - min) + min);
  };

  // Cleanup just in case
  useEffect(() => {
    return () => {
      const node = ref.current;
      if (node && dragState.current.pointerId !== null) {
        try {
          node.releasePointerCapture(dragState.current.pointerId);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  return (
    <div className={`flex flex-col items-center gap-1 select-none touch-none ${className}`}>
      <div
        ref={ref}
        className="relative cursor-ns-resize group touch-none"
        style={{ width: size, height: size, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={handleDoubleClick}
        title="Drag up/down | Shift for precision | Double click reset"
      >
        <svg width={size} height={size} className="drop-shadow-sm pointer-events-none">
          <path
            d={trackPath}
            fill="none"
            stroke="#D9DBD6"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          {valuePath && (
            <path
              d={valuePath}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              className={`transition-all ${dragging ? 'duration-0' : 'duration-75 ease-out'}`}
              style={{ opacity: 0.9, filter: `drop-shadow(0 0 3px ${color}40)` }}
            />
          )}
        </svg>
        <div
          className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          <div className="w-1 h-3 bg-white rounded-full absolute -top-1 shadow-sm" />
        </div>
      </div>

      <div className="flex flex-col items-center pointer-events-none mt-1">
        {label && (
          <span className="text-[9px] font-bold text-[#7A8476] uppercase tracking-wider leading-none mb-0.5 opacity-80">
            {label}
          </span>
        )}
        <span
          className={`text-[10px] font-mono font-bold leading-none transition-colors ${
            dragging ? 'text-[#2E2F2B]' : 'text-[#5F665F]'
          }`}
        >
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

