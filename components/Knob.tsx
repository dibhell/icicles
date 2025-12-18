import React, { useState, useRef, useEffect } from 'react';

interface KnobProps {
  label?: string;
  value: number;
  defaultValue?: number;
  min: number;
  max: number;
  step?: number;
  onChange: (val: number) => void;
  format?: (val: number) => string;
  color?: string;
  size?: number;
}

export const Knob: React.FC<KnobProps> = ({
  label,
  value,
  defaultValue,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  color = '#7A8476',
  size = 48,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const range = max - min;
  const normalized = Math.min(1, Math.max(0, (value - min) / range));
  const rotation = normalized * 270 - 135; // -135 to +135

  const sensitivity = range / 200; // 200px for full range

  const processMove = (clientY: number) => {
    const deltaY = startY.current - clientY; // up is positive
    let newValue = startValue.current + deltaY * sensitivity;
    if (step > 0) newValue = Math.round(newValue / step) * step;
    newValue = Math.max(min, Math.min(max, newValue));
    const snap = step > 0 ? step * 0.6 : 0.001;
    if (Math.abs(newValue - min) <= snap) newValue = min;
    if (Math.abs(newValue - max) <= snap) newValue = max;
    if (newValue !== value) onChange(newValue);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    startY.current = e.clientY;
    startValue.current = value;
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: MouseEvent) => {
    e.preventDefault();
    processMove(e.clientY);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startValue.current = value;
    document.body.style.overflow = 'hidden';
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    processMove(e.touches[0].clientY);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    document.body.style.overflow = '';
  };

  const handleDoubleClick = () => {
    if (defaultValue !== undefined) onChange(defaultValue);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.overflow = '';
    };
  }, []);

  // SVG arc via explicit path (start at -135°, sweep 270°)
  const strokeWidth = size * 0.1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - strokeWidth;
  const startDeg = -135;
  const sweepDeg = 270;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const polar = (deg: number) => {
    const rad = toRad(deg);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const trackStart = polar(startDeg);
  const trackEnd = polar(startDeg + sweepDeg);
  const trackLargeArc = sweepDeg > 180 ? 1 : 0;
  const trackPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${trackLargeArc} 1 ${trackEnd.x} ${trackEnd.y}`;

  const valueDeg = startDeg + sweepDeg * normalized;
  const valueEnd = polar(valueDeg);
  const valueLargeArc = valueDeg - startDeg > 180 ? 1 : 0;
  const valuePath =
    normalized <= 0.0001
      ? ''
      : `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${valueLargeArc} 1 ${valueEnd.x} ${valueEnd.y}`;

  return (
    <div className="flex flex-col items-center gap-1 select-none touch-none">
      <div
        className="relative cursor-ns-resize group touch-none"
        style={{ width: size, height: size, touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
        title="Drag up/down | Double click reset"
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
              className="transition-all duration-75 ease-out"
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
            isDragging ? 'text-[#2E2F2B]' : 'text-[#5F665F]'
          }`}
        >
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
    </div>
  );
};
