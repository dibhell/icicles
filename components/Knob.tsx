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
  const startY = useRef<number>(0);
  const startValue = useRef<number>(0);

  const range = max - min;
  const normalized = range <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / range));
  const rotation = normalized * 270 - 135;

  // --- COMMON LOGIC ---
  const processMove = (clientY: number) => {
    const deltaY = startY.current - clientY; // Up is positive
    const sensitivity = range / 200;

    let newValue = startValue.current + deltaY * sensitivity;

    newValue = Math.round(newValue / step) * step;
    newValue = Math.max(min, Math.min(max, newValue));

    onChange(newValue);
  };

  // --- MOUSE EVENTS ---
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

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startY.current = e.clientY;
    startValue.current = value;

    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // --- TOUCH EVENTS (Mobile) ---
  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startValue.current = value;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    // podczas kręcenia blokujemy przewijanie TYLKO na tym elemencie
    e.preventDefault();
    processMove(e.touches[0].clientY);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    if (defaultValue !== undefined) onChange(defaultValue);
  };

  // Cleanup (mysz)
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SVG Arc calculation
  const r = size / 2 - 4;
  const dashArray = 2 * Math.PI * r;
  const dashOffset = dashArray - normalized * (dashArray * 0.75);
  const strokeWidth = size * 0.1;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        className="relative cursor-ns-resize group"
        style={{
          width: size,
          height: size,
          // scroll działa normalnie, dopóki nie kręcisz
          touchAction: isDragging ? 'none' : 'pan-y',
        }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
        title="Double-click to reset"
      >
        <svg width={size} height={size} className="transform rotate-90 drop-shadow-sm pointer-events-none">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#D9DBD6"
            strokeWidth={strokeWidth}
            strokeDasharray={dashArray}
            strokeDashoffset={dashArray * 0.25}
            strokeLinecap="round"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            className="transition-all duration-75 ease-out"
            style={{ opacity: 0.9, filter: `drop-shadow(0 0 2px ${color}40)` }}
          />
        </svg>

        <div
          className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          <div
            className="bg-[#F2F2F0] rounded-full absolute -top-[10%] shadow-sm border border-[#B9BCB7]"
            style={{ width: strokeWidth, height: strokeWidth * 2.5 }}
          />
        </div>
      </div>

      <div className="text-center">
        {label && <div className="text-[9px] font-bold text-[#7A8476] uppercase tracking-wider">{label}</div>}
        <div className={`text-[10px] font-mono font-bold ${isDragging ? 'text-[#3F453F]' : 'text-[#5F665F]'}`}>
          {format ? format(value) : value.toFixed(2)}
        </div>
      </div>
    </div>
  );
};
