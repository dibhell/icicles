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
    size = 48
}) => {
    // Internal state only for visual feedback (cursor style, highlighting)
    const [isDragging, setIsDragging] = useState(false);
    
    // Refs to hold mutable values for the event listeners without triggering re-renders
    const stateRef = useRef({
        startY: 0,
        startValue: 0,
        isDragging: false
    });

    // --- MATH CONSTANTS ---
    // Higher = more precision (slower movement). 
    // 150px feels responsive and modern.
    const SENSITIVITY = 140; 

    // --- CORE LOGIC ---
    // Calculates new value based on delta Y
    const updateValue = (clientY: number, shiftKey: boolean) => {
        const { startY, startValue } = stateRef.current;
        const deltaY = startY - clientY; // Up is positive
        
        // Dynamic range based on Min/Max
        const range = max - min;
        
        // Calculate raw change (0.0 to 1.0 scale usually)
        // Shift key slows it down by 5x for fine-tuning
        const speed = shiftKey ? SENSITIVITY * 5 : SENSITIVITY;
        
        const deltaValue = (deltaY / speed) * range;
        let newValue = startValue + deltaValue;

        // Clamp
        newValue = Math.max(min, Math.min(max, newValue));

        // Step
        if (step > 0) newValue = Math.round(newValue / step) * step;

        // Snap to edges if close (avoid getting stuck at 0.1 etc.)
        const snap = step > 0 ? step * 0.6 : 0.001;
        if (Math.abs(newValue - min) <= snap) newValue = min;
        if (Math.abs(newValue - max) <= snap) newValue = max;

        // Precision Clamp (fix JS float errors like 0.300000004)
        newValue = Math.round(newValue * 10000) / 10000;

        if (newValue !== value) {
            onChange(newValue);
        }
    };

    // --- MOUSE HANDLERS (PC) ---
    // We attach listeners to WINDOW so you can drag anywhere
    const onMouseDown = (e: React.MouseEvent) => {
        e.preventDefault(); // Prevent text selection
        e.stopPropagation();

        setIsDragging(true);
        stateRef.current = {
            startY: e.clientY,
            startValue: value,
            isDragging: true
        };

        document.body.style.cursor = 'ns-resize';
        window.addEventListener('mousemove', onWindowMouseMove);
        window.addEventListener('mouseup', onWindowMouseUp);
    };

    const onWindowMouseMove = (e: MouseEvent) => {
        if (!stateRef.current.isDragging) return;
        e.preventDefault();
        updateValue(e.clientY, e.shiftKey);
    };

    const onWindowMouseUp = () => {
        setIsDragging(false);
        stateRef.current.isDragging = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onWindowMouseMove);
        window.removeEventListener('mouseup', onWindowMouseUp);
    };

    // --- TOUCH HANDLERS (MOBILE) ---
    const onTouchStart = (e: React.TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        setIsDragging(true);
        stateRef.current = {
            startY: e.touches[0].clientY,
            startValue: value,
            isDragging: true
        };

        // Lock scroll on mobile
        document.body.style.overflow = 'hidden';
        
        // Attach touch listeners to window (safest for "drag out")
        window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
        window.addEventListener('touchend', onWindowTouchEnd);
    };

    const onWindowTouchMove = (e: TouchEvent) => {
        if (!stateRef.current.isDragging) return;
        e.preventDefault(); // Crucial to prevent scroll during drag
        updateValue(e.touches[0].clientY, false);
    };

    const onWindowTouchEnd = () => {
        setIsDragging(false);
        stateRef.current.isDragging = false;
        document.body.style.overflow = '';
        window.removeEventListener('touchmove', onWindowTouchMove);
        window.removeEventListener('touchend', onWindowTouchEnd);
    };

    const handleDoubleClick = () => {
        if (defaultValue !== undefined) onChange(defaultValue);
    };

    // Cleanup on unmount just in case
    useEffect(() => {
        return () => {
            window.removeEventListener('mousemove', onWindowMouseMove);
            window.removeEventListener('mouseup', onWindowMouseUp);
            window.removeEventListener('touchmove', onWindowTouchMove);
            window.removeEventListener('touchend', onWindowTouchEnd);
            document.body.style.cursor = '';
            document.body.style.overflow = '';
        };
    }, []);

    // --- VISUALS ---
    const normalized = Math.min(1, Math.max(0, (value - min) / (max - min)));
    // 270 degree arc (-135 to +135)
    const startDeg = -135;
    const sweepDeg = 270;
    const rotation = startDeg + (normalized * sweepDeg);
    
    // SVG Math
    const strokeWidth = size * 0.1;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - strokeWidth;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const polar = (deg: number) => {
        const rad = toRad(deg);
        return { x: cx + r * Math.cos(rad), y: cy + Math.sin(rad) };
    };

    const c = 2 * Math.PI * r;
    const arc = c * (sweepDeg / 360);

    const trackStart = polar(startDeg);
    const trackEnd = polar(startDeg + sweepDeg);
    const trackLargeArc = sweepDeg > 180 ? 1 : 0;
    const trackPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${trackLargeArc} 1 ${trackEnd.x} ${trackEnd.y}`;

    const valueDeg = startDeg + sweepDeg * normalized;
    const valueEnd = polar(valueDeg);
    const valueLargeArc = valueDeg - startDeg > 180 ? 1 : 0;
    const valuePath = normalized <= 0.0001
        ? `M ${trackStart.x} ${trackStart.y} L ${trackStart.x + 0.001} ${trackStart.y + 0.001}`
        : `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${valueLargeArc} 1 ${valueEnd.x} ${valueEnd.y}`;

    return (
        <div className="flex flex-col items-center gap-1 select-none touch-none">
            <div 
                className="relative cursor-ns-resize group touch-none"
                style={{ width: size, height: size, touchAction: 'none' }}
                onMouseDown={onMouseDown}
                onTouchStart={onTouchStart}
                onDoubleClick={handleDoubleClick}
                title="Drag up/down | Shift for precision | Double click reset"
            >
                {/* SVG Ring */}
                <svg width={size} height={size} className="pointer-events-none drop-shadow-sm">
                    {/* Track */}
                    <circle
                        cx={size/2} cy={size/2} r={r}
                        fill="none"
                        stroke="#D9DBD6"
                        strokeWidth={strokeWidth}
                        strokeDasharray={`${arc} ${c}`}
                        strokeDashoffset={0}
                        strokeLinecap="round"
                        transform={baseTransform}
                    />
                    {/* Active */}
                    <circle
                        cx={size/2} cy={size/2} r={r}
                        fill="none"
                        stroke={color}
                        strokeWidth={strokeWidth}
                        strokeDasharray={`${arc} ${c}`}
                        strokeDashoffset={offset}
                        strokeLinecap="round"
                        className={`transition-[stroke-dashoffset] ${isDragging ? 'duration-0' : 'duration-200 ease-out'}`}
                        style={{ opacity: 0.9 }}
                        transform={baseTransform}
                    />
                </svg>

                {/* Indicator Tick */}
                <div 
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                    style={{ transform: `rotate(${rotation}deg)` }}
                >
                    <div 
                        className={`absolute -top-[5%] w-1 rounded-full transition-all duration-200
                        ${isDragging ? 'bg-[#2E2F2B] h-3' : 'bg-[#7A8476] h-2.5'}`} 
                    />
                </div>
            </div>

            {/* Label */}
            <div className="flex flex-col items-center pointer-events-none mt-1">
                {label && (
                    <span className="text-[9px] font-bold text-[#7A8476] uppercase tracking-wider leading-none mb-0.5 opacity-80">
                        {label}
                    </span>
                )}
                <span className={`text-[10px] font-mono font-bold leading-none transition-colors
                    ${isDragging ? 'text-[#2E2F2B]' : 'text-[#5F665F]'}`}>
                    {format ? format(value) : value.toFixed(2)}
                </span>
            </div>
        </div>
    );
};
