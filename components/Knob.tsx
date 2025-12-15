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
    color = '#7A8476', // C7: Moss Green
    size = 48
}) => {
    const [isDragging, setIsDragging] = useState(false);
    const startY = useRef<number>(0);
    const startValue = useRef<number>(0);
    
    // Calculate rotation (0 to 270 degrees)
    const range = max - min;
    const normalized = Math.min(1, Math.max(0, (value - min) / range));
    const rotation = normalized * 270 - 135; // -135 to +135

    // --- LOGIC ---
    const processMove = (clientY: number) => {
        const deltaY = startY.current - clientY; // Up is positive
        const sensitivity = range / 200; // 200px for full range
        
        let newValue = startValue.current + (deltaY * sensitivity);
        
        // Snap to step
        newValue = Math.round(newValue / step) * step;
        newValue = Math.max(min, Math.min(max, newValue));
        
        onChange(newValue);
    };

    // --- MOUSE EVENTS ---
    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault(); // Prevent text selection
        setIsDragging(true);
        startY.current = e.clientY;
        startValue.current = value;
        document.body.style.cursor = 'ns-resize';
        
        window.addEventListener('mousemove', handleWindowMouseMove);
        window.addEventListener('mouseup', handleWindowMouseUp);
    };

    const handleWindowMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        processMove(e.clientY);
    };

    const handleWindowMouseUp = () => {
        setIsDragging(false);
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', handleWindowMouseMove);
        window.removeEventListener('mouseup', handleWindowMouseUp);
    };

    // --- TOUCH EVENTS ---
    // Using touch-action: none in CSS is preferred over preventing default in JS for modern React
    const handleTouchStart = (e: React.TouchEvent) => {
        setIsDragging(true);
        startY.current = e.touches[0].clientY;
        startValue.current = value;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        // e.preventDefault() is often problematic with passive listeners.
        // We rely on touch-action: none css property to disable scrolling.
        processMove(e.touches[0].clientY);
    };

    const handleTouchEnd = () => {
        setIsDragging(false);
    };

    // Cleanup on unmount just in case
    useEffect(() => {
        return () => {
            window.removeEventListener('mousemove', handleWindowMouseMove);
            window.removeEventListener('mouseup', handleWindowMouseUp);
        };
    }, []);

    const handleDoubleClick = () => {
        if (defaultValue !== undefined) {
            onChange(defaultValue);
        }
    };

    // SVG Arc calculation
    const r = size / 2 - 4; // radius based on size with padding
    const dashArray = 2 * Math.PI * r;
    const dashOffset = dashArray - (normalized * (dashArray * 0.75));
    const strokeWidth = size * 0.1;

    return (
        <div className="flex flex-col items-center gap-1 select-none">
             <div 
                className="relative cursor-ns-resize group"
                style={{ 
                    width: size, 
                    height: size,
                    touchAction: 'none' // CRITICAL: This prevents scroll on mobile, enabling native-like knob control
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
                    {/* Background Track */}
                    <circle 
                        cx={size/2} cy={size/2} r={r} 
                        fill="none" 
                        stroke="#D9DBD6" 
                        strokeWidth={strokeWidth}
                        strokeDasharray={dashArray}
                        strokeDashoffset={dashArray * 0.25} // Leave gap
                        strokeLinecap="round"
                    />
                    {/* Value Arc */}
                    <circle 
                        cx={size/2} cy={size/2} r={r} 
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
                
                {/* Indicator Dot */}
                <div 
                    className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"
                    style={{ transform: `rotate(${rotation}deg)` }}
                >
                    <div 
                        className="bg-[#F2F2F0] rounded-full absolute -top-[10%] shadow-sm border border-[#B9BCB7]"
                        style={{ width: strokeWidth, height: strokeWidth * 2.5 }}
                    ></div>
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
