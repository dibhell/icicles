import React, { useState, useRef } from 'react';

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
    size = 48
}) => {
    // Visual state for active interaction
    const [isDragging, setIsDragging] = useState(false);
    
    // Store drag session data to calculate delta from the initial click point
    // This prevents accumulation errors and drift
    const dragRef = useRef<{
        startY: number;
        startValue: number;
    } | null>(null);

    // --- INTERACTION CONSTANTS ---
    // How many pixels of vertical movement for the full range?
    // 128px is a standard "feeling" distance (power of 2, feels musical/natural)
    const PIXELS_FULL_RANGE = 128; 

    const handlePointerDown = (e: React.PointerEvent) => {
        // Prevent default browser behaviors (scrolling, text selection)
        e.preventDefault();
        e.stopPropagation();

        const target = e.currentTarget as HTMLDivElement;
        
        // CRITICAL: Capture the pointer so we receive events even if cursor leaves the div
        // or goes off-screen. This is the modern replacement for global window listeners.
        target.setPointerCapture(e.pointerId);
        
        setIsDragging(true);
        dragRef.current = {
            startY: e.clientY,
            startValue: value
        };
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current) return;
        
        e.preventDefault();
        e.stopPropagation();

        const { startY, startValue } = dragRef.current;
        
        // Calculate Delta: Up movement (decreasing Y) should increase value
        const deltaPixel = startY - e.clientY; 
        
        // Calculate value change relative to the full range
        // Multiplier helps adjust "speed" (SHIFT key could potentially modify PIXELS_FULL_RANGE)
        const range = max - min;
        const deltaValue = (deltaPixel / PIXELS_FULL_RANGE) * range;
        
        let newValue = startValue + deltaValue;

        // 1. Clamp to Min/Max
        newValue = Math.min(max, Math.max(min, newValue));

        // 2. Snap to Step (if defined)
        if (step > 0) {
            newValue = Math.round(newValue / step) * step;
        }

        // 3. Re-Clamp (to handle float rounding artifacts at edges)
        newValue = Math.min(max, Math.max(min, newValue));

        // 4. Update if different
        // Use a small epsilon for float comparison to avoid unnecessary updates
        if (Math.abs(newValue - value) > 0.00001) {
            onChange(newValue);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        setIsDragging(false);
        dragRef.current = null;
        
        const target = e.currentTarget as HTMLDivElement;
        target.releasePointerCapture(e.pointerId);
    };

    const handleDoubleClick = () => {
        if (defaultValue !== undefined) onChange(defaultValue);
    };

    // --- VISUAL CALCULATIONS ---
    const normalized = (value - min) / (max - min);
    // Map 0..1 to -135deg..+135deg (Total 270 degree arc)
    const rotation = -135 + (normalized * 270);

    // SVG geometry
    const strokeWidth = size * 0.12;
    // const radius = (size / 2) - (strokeWidth);
    
    // Reverting to the proven SVG math from previous successful iteration for visuals,
    // as that wasn't the broken part and looked good.
    const r = size / 2 - 4;
    const c = 2 * Math.PI * r;
    const offset = c - normalized * (c * 0.75); // proven offset formula

    return (
        <div className="flex flex-col items-center gap-2 touch-none select-none">
            <div 
                className="relative cursor-ns-resize group"
                style={{ 
                    width: size, 
                    height: size, 
                    touchAction: 'none' // CRITICAL for mobile scroll prevention
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onDoubleClick={handleDoubleClick}
                title="Drag vertically to adjust"
            >
                {/* SVG Dial */}
                <svg width={size} height={size} className="transform rotate-90 pointer-events-none filter drop-shadow-sm">
                    {/* Track */}
                    <circle
                        cx={size/2} cy={size/2} r={r}
                        fill="none"
                        stroke="#D9DBD6"
                        strokeWidth={strokeWidth}
                        strokeDasharray={c}
                        strokeDashoffset={c * 0.25} // 25% gap
                        strokeLinecap="round"
                    />
                    {/* Active Value */}
                    <circle
                        cx={size/2} cy={size/2} r={r}
                        fill="none"
                        stroke={color}
                        strokeWidth={strokeWidth}
                        strokeDasharray={c}
                        strokeDashoffset={offset}
                        strokeLinecap="round"
                        className="transition-[stroke-dashoffset] duration-75"
                        style={{ filter: isDragging ? `drop-shadow(0 0 3px ${color})` : 'none' }}
                    />
                </svg>

                {/* Physical Indicator Tick */}
                <div 
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                    style={{ transform: `rotate(${rotation}deg)` }}
                >
                    <div className={`absolute -top-[10%] w-1.5 h-2.5 rounded-full transition-colors border-[0.5px] border-black/10 
                        ${isDragging ? 'bg-white shadow-md' : 'bg-[#F2F2F0] shadow-sm'}`} 
                    />
                </div>
            </div>

            {/* Labels */}
            <div className="flex flex-col items-center pointer-events-none">
                {label && (
                    <span className="text-[9px] font-bold text-[#7A8476] uppercase tracking-widest mb-0.5">
                        {label}
                    </span>
                )}
                <span className={`text-[10px] font-mono font-bold tabular-nums leading-none 
                    ${isDragging ? 'text-[#2E2F2B]' : 'text-[#5F665F]'}`}>
                    {format ? format(value) : value.toFixed(2)}
                </span>
            </div>
        </div>
    );
};
