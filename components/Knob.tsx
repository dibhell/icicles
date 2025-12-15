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
  
  // We store interaction state in refs to avoid re-renders during calculation
  // and to maintain absolute tracking logic.
  const state = useRef({
    startY: 0,
    startValue: 0,
  });

  // --- MATH HELPERS ---
  const range = max - min;
  const normalized = range <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / range));
  // Rotation: -135deg (min) to +135deg (max)
  const rotation = normalized * 270 - 135;

  // --- POINTER EVENTS (Unified Mouse & Touch) ---
  
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    
    // Capture pointer: This is crucial. It ensures we keep receiving events
    // even if the mouse/finger leaves the element boundaries.
    e.currentTarget.setPointerCapture(e.pointerId);

    state.current = {
      startY: e.clientY,
      startValue: value, // We track from where you clicked
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();

    const { startY, startValue } = state.current;
    
    // Sensitivity: How many pixels to drag for full range?
    // 125px feels responsive on desktop without being twitchy.
    const pixelRange = 125; 
    
    // Delta Y: Up is negative in screen coords, but we want Up to increase value.
    const deltaY = startY - e.clientY; 
    
    // Calculate raw change based on percentage of pixelRange
    const change = (deltaY / pixelRange) * range;
    let newValue = startValue + change;

    // Logic: Apply step, but prevent "stickiness"
    // If step is defined, we snap.
    if (step > 0) {
      newValue = Math.round(newValue / step) * step;
    }

    // Clamp limits
    newValue = Math.max(min, Math.min(max, newValue));

    // Optimization: Only update if value actually changed (float comparison)
    if (Math.abs(newValue - value) >= (step / 2)) {
      onChange(newValue);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const handleDoubleClick = () => {
    if (defaultValue !== undefined) onChange(defaultValue);
  };

  // --- VISUALS ---
  const r = size / 2 - 4;
  const dashArray = 2 * Math.PI * r;
  const dashOffset = dashArray - normalized * (dashArray * 0.75);
  const strokeWidth = size * 0.1;

  return (
    <div className="flex flex-col items-center gap-1 select-none touch-none">
      <div
        className="relative group outline-none"
        style={{
          width: size,
          height: size,
          cursor: isDragging ? 'ns-resize' : 'pointer',
          // CRITICAL: Tells browser not to handle gestures/scrolling on this element
          touchAction: 'none' 
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp} // Handle interruption
        onDoubleClick={handleDoubleClick}
        title="Drag up/down | Double-click reset"
      >
        <svg 
          width={size} 
          height={size} 
          className="transform rotate-90 drop-shadow-sm pointer-events-none"
        >
          {/* Background Track */}
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
          {/* Active Value Arc */}
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
            style={{ 
              opacity: 0.9, 
              filter: `drop-shadow(0 0 2px ${color}40)` 
            }}
          />
        </svg>

        {/* Indicator */}
        <div
          className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          <div
            className={`bg-[#F2F2F0] rounded-full absolute -top-[10%] shadow-sm border border-[#B9BCB7] transition-colors ${isDragging ? 'bg-white border-[#7A8476]' : ''}`}
            style={{ width: strokeWidth, height: strokeWidth * 2.5 }}
          />
        </div>
      </div>

      <div className="text-center pointer-events-none">
        {label && (
          <div className="text-[9px] font-bold text-[#7A8476] uppercase tracking-wider leading-none mb-0.5">
            {label}
          </div>
        )}
        <div className={`text-[10px] font-mono font-bold leading-none ${isDragging ? 'text-[#3F453F]' : 'text-[#5F665F]'}`}>
          {format ? format(value) : value.toFixed(2)}
        </div>
      </div>
    </div>
  );
};
