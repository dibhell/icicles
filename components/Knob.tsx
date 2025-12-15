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
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const range = max - min;
  const normalized = Math.min(1, Math.max(0, (value - min) / range));
  const rotation = normalized * 270 - 135;

  const processMove = (clientY: number) => {
    const deltaY = startY.current - clientY;
    const sensitivity = range / 200;
    let next = startValue.current + deltaY * sensitivity;
    next = Math.round(next / step) * step;
    next = Math.max(min, Math.min(max, next));
    onChange(next);
  };

  // ---------- MOUSE ----------
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startY.current = e.clientY;
    startValue.current = value;
    document.body.style.cursor = 'ns-resize';

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e: MouseEvent) => {
    processMove(e.clientY);
  };

  const onMouseUp = () => {
    setIsDragging(false);
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  // ---------- TOUCH ----------
  const onTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startValue.current = value;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    e.preventDefault(); // KLUCZOWE
    processMove(e.touches[0].clientY);
  };

  const onTouchEnd = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const onDoubleClick = () => {
    if (defaultValue !== undefined) onChange(defaultValue);
  };

  const r = size / 2 - 4;
  const dashArray = 2 * Math.PI * r;
  const dashOffset = dashArray - normalized * (dashArray * 0.75);
  const strokeWidth = size * 0.1;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        className="relative cursor-ns-resize"
        style={{
          width: size,
          height: size,
          touch
