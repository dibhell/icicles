import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Knob } from './Knob';

type BufferedKnobProps = {
  value: number;
  onCommit: (v: number) => void;
  live?: boolean;
  min?: number;
  max?: number;
  defaultValue?: number;
  steps?: number;
  sensitivity?: number;
  fineSensitivity?: number;
  disabled?: boolean;
  className?: string;
  label?: string;
  format?: (v: number) => string;
  color?: string;
  size?: number;
};

/**
 * Knob wrapper that keeps a local UI state during drag and commits to engine
 * on pointer up or with a light throttle. Engine updates do not overwrite UI
 * while the user is interacting.
 */
export function BufferedKnob({
  value,
  onCommit,
  live = false,
  min = 0,
  max = 1,
  defaultValue = 0,
  steps,
  sensitivity,
  fineSensitivity,
  disabled,
  className,
  label,
  format,
  color,
  size,
}: BufferedKnobProps) {
  const [uiValue, setUiValue] = useState(value);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const commitNow = useCallback(
    (next?: number) => {
      const v = next ?? uiValue;
      onCommit(v);
      dirtyRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = null;
    },
    [onCommit, uiValue]
  );

  useEffect(() => {
    if (!dirtyRef.current) {
      setUiValue(value);
    }
  }, [value]);

  const scheduleCommit = useCallback(
    (next: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => commitNow(next), 50);
    },
    [commitNow]
  );

  const handleChange = (v: number) => {
    dirtyRef.current = true;
    setUiValue(v);
    if (live) {
      pendingRef.current = v;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => commitNow(pendingRef.current ?? v));
      }
      return;
    }
    scheduleCommit(v);
  };

  useEffect(() => {
    const handleUp = () => {
      if (dirtyRef.current) commitNow();
    };
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [commitNow]);

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);
  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  return (
    <Knob
      value={uiValue}
      onChange={handleChange}
      min={min}
      max={max}
      defaultValue={defaultValue}
      steps={steps}
      sensitivity={sensitivity}
      fineSensitivity={fineSensitivity}
      disabled={disabled}
      className={className}
      label={label}
      format={format}
      color={color}
      size={size}
    />
  );
}

