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
  
  // Internal state to track the RAW drag value before snapping.
  // This prevents the "stair-stepping" lag effect where small mouse movements
  // get lost because they don't cross the next 'step' threshold immediately.
  const dragInfo = useRef({
    startY: 0,
    startValue: 0,
    currentRawValue: 0 // High precision value
  });

  // --- MATH HELPERS ---
  const range = max - min;
  const normalized = range <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / range));
  const rotation = normalized * 270 - 135;

  // --- POINTER EVENTS ---
  
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);

    dragInfo.current = {
      startY: e.clientY,
      startValue: value,
      currentRawValue: value
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    e.stopPropagation();

    const { startY, startValue } = dragInfo.current;
    
    // Sensitivity: Pixels required for full range rotation.
    // Standard VST feel is around 150-200px.
    let pixelRange = 150; 
    
    // Shift key for fine-tuning (Precision Mode)
    if (e.shiftKey) {
        pixelRange *= 5; // 5x slower movement for precision
    }

    const deltaY = startY - e.clientY; // Up is positive
    
    // Calculate precise float change
    const deltaValue = (deltaY / pixelRange) * range;
    let rawNewValue = startValue + deltaValue;

    // Clamp RAW value to ensure we don't drift endlessly past min/max
    rawNewValue = Math.max(min, Math.min(max, rawNewValue));
    dragInfo.current.currentRawValue = rawNewValue;

    // Apply Step Snapping ONLY for the output
    let outputValue = rawNewValue;
    if (step > 0) {
      outputValue = Math.round(rawNewValue / step) * step;
    }

    // Final Clamp
    outputValue = Math.max(min, Math.min(max, outputValue));

    // Fire event (removed the threshold check to ensure instant feedback)
    if (outputValue !== value) {
      onChange(outputValue);
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
          touchAction: 'none' 
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        title="Drag up/down | Shift+Drag for precision | Double-click reset"
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
