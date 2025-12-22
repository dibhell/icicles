import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSettings } from '../types';
import { Play, Pause, Square, Sliders, Mic2, XCircle, Bus, Headphones, Brush, Book, Database } from 'lucide-react';
import { audioService } from '../services/audioEngine';
import { BufferedKnob } from './BufferedKnob';
import { TapeCassette } from './TapeCassette';

interface MixerProps {
  settings: AudioSettings;
  setSettings: React.Dispatch<React.SetStateAction<AudioSettings>>;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const dbToLevel = (db: number) => {
  if (!Number.isFinite(db) || db <= -60) return 0;
  return clamp(Math.pow(10, db / 20), 0, 1);
};

const BulbIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M12 1.25v1.05" />
    <path
      d="
        M7.8 5.8
        C7.8 4.0 9.6 2.9 12.0 2.9
        C14.4 2.9 16.2 4.0 16.2 5.8
        V14.0
        C16.2 15.4 14.8 16.2 12.0 16.2
        C9.2 16.2 7.8 15.4 7.8 14.0
        Z"
    />
    <path d="M12 6.6v6.0" opacity="0.65" />
    <path d="M8.4 16.2v1.7" />
    <path d="M10.8 16.2v2.5" />
    <path d="M13.2 16.2v2.5" />
    <path d="M15.6 16.2v1.7" />
  </svg>
);
const TRACK_TOP = 8;
const TRACK_BOTTOM = 8;
const THUMB_RADIUS = 8;
const HITBOX_MIN_W = 36;
const FADER_HEIGHT = 150;
const LABEL_ROW_H = 10;
const VALUE_ROW_H = 10;
const CONTROL_ZONE_H = LABEL_ROW_H + FADER_HEIGHT + VALUE_ROW_H;
const CONTROL_COL_W = 72;
const FADER_TRACK_W = 10; // align with VU meter width
const DATA_GRID_COLS = '1fr 16px 1fr 16px';
const MAX_RECORD_MS = 10000;

type FallbackRecorder = {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silent: GainNode;
  buffers: Float32Array[];
  sampleRate: number;
};

const encodeWav = (buffers: Float32Array[], sampleRate: number) => {
  const length = buffers.reduce((sum, b) => sum + b.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  buffers.forEach((buf) => {
    for (let i = 0; i < buf.length; i++) {
      const sample = Math.max(-1, Math.min(1, buf[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  });

  return new Blob([view.buffer], { type: 'audio/wav' });
};

type FaderProps = {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (v: number) => void;
  disabled?: boolean;
};

const Fader: React.FC<FaderProps> = ({ value, min, max, defaultValue, onChange, disabled }) => {
  const stateRef = useRef({
    pointerId: -1,
    startY: 0,
    startX: 0,
    startVal: 0,
    moved: false,
    lastUpAt: 0,
  });

  const ratio = clamp((value - min) / (max - min || 1), 0, 1);
  const travel = FADER_HEIGHT - TRACK_TOP - TRACK_BOTTOM - THUMB_RADIUS * 2;
  const thumbBottom = TRACK_BOTTOM + ratio * travel;
  const fillHeight = Math.max(0, thumbBottom - TRACK_BOTTOM);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    stateRef.current.pointerId = e.pointerId;
    stateRef.current.startY = e.clientY;
    stateRef.current.startX = e.clientX;
    stateRef.current.startVal = value;
    stateRef.current.moved = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== stateRef.current.pointerId) return;
      ev.preventDefault();
      const dy = stateRef.current.startY - ev.clientY;
      const sensitivity = (max - min) / travel;
      let next = stateRef.current.startVal + dy * sensitivity;
      next = clamp(next, min, max);
      if (Math.abs(dy) > 3) stateRef.current.moved = true;
      onChange(next);
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== stateRef.current.pointerId) return;
      ev.preventDefault();
      const now = performance.now();
      const dx = ev.clientX - stateRef.current.startX;
      const dy = ev.clientY - stateRef.current.startY;
      const dist = Math.hypot(dx, dy);
      const dt = now - stateRef.current.lastUpAt;
      const isDouble = dist < 4 && dt < 300 && !stateRef.current.moved;
      if (isDouble) {
        onChange(defaultValue);
        stateRef.current.lastUpAt = 0;
      } else {
        stateRef.current.lastUpAt = now;
      }
      stateRef.current.pointerId = -1;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { passive: false });
    window.addEventListener('pointercancel', up, { passive: false });
  };

  return (
    <div className="relative flex items-center justify-center" style={{ height: FADER_HEIGHT, width: HITBOX_MIN_W }}>
      <div
        className="pointer-events-none absolute"
        style={{ top: TRACK_TOP, bottom: TRACK_BOTTOM, left: '50%', transform: 'translateX(-50%)', width: FADER_TRACK_W, backgroundColor: '#B9BCB7', borderRadius: 999 }}
      />
      <div
        className="pointer-events-none absolute"
        style={{ bottom: TRACK_BOTTOM, left: '50%', transform: 'translateX(-50%)', width: FADER_TRACK_W, height: fillHeight, backgroundColor: '#7A8476', borderRadius: 999, opacity: 0.95 }}
      />
      <div
        className="pointer-events-none absolute bg-[#7A8476] rounded-full shadow-sm"
        style={{ width: THUMB_RADIUS * 2, height: THUMB_RADIUS * 2, left: '50%', transform: 'translateX(-50%)', bottom: thumbBottom }}
      />
      <div
        className="absolute inset-0"
        style={{ minWidth: HITBOX_MIN_W, height: '100%', opacity: 0, touchAction: 'none', pointerEvents: disabled ? 'none' : 'auto' }}
        onPointerDown={handlePointerDown}
      />
    </div>
  );
};

type ControlColumnProps = {
  label: string;
  bottom: React.ReactNode;
  children: React.ReactNode;
};

const ControlColumn: React.FC<ControlColumnProps> = ({ label, bottom, children }) => (
  <div
    className="grid justify-items-center"
    style={{
      width: CONTROL_COL_W,
      gridTemplateRows: `${LABEL_ROW_H}px ${FADER_HEIGHT}px ${VALUE_ROW_H}px`,
    }}
  >
    <div className="w-full text-center text-[8px] uppercase opacity-60 leading-none flex items-end justify-center">{label}</div>
    <div className="flex items-center justify-center">{children}</div>
    <div className="w-full text-center text-[9px] opacity-60 leading-none flex items-start justify-center tabular-nums">{bottom}</div>
  </div>
);

export const Mixer: React.FC<MixerProps> = ({ settings, setSettings, isPlaying, onPlayPause, onStop }) => {
  const peakCanvasRef = useRef<HTMLCanvasElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const micVURef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunks = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderTimerRef = useRef<number | null>(null);
  const fallbackRecorderRef = useRef<FallbackRecorder | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [bank, setBank] = useState(audioService.getBankSnapshot());
  const [micGain, setMicGain] = useState(2.6);
  const [lofiEnabled, setLofiEnabled] = useState(false);
  const [lofiDrive, setLofiDrive] = useState(0);
  const [lofiTape, setLofiTape] = useState(0);
  const [lofiCrush, setLofiCrush] = useState(0);
  const [lofiLevel, setLofiLevel] = useState(0);
  const lofiLevelUpdateRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sampleLoadRef = useRef({ startIndex: 0, overwrite: false });
  const recordSlotRef = useRef<number | null>(null);
  const loadedWrapRef = useRef<HTMLDivElement>(null);
  const loadedTextRef = useRef<HTMLSpanElement>(null);
  const [loadedShift, setLoadedShift] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState(12);
  const sampleInputId = 'sample-input';

  const handleEQChange = (band: 'low' | 'mid' | 'high', val: number) => {
    const nextLow = band === 'low' ? val : settings.low;
    const nextMid = band === 'mid' ? val : settings.mid;
    const nextHigh = band === 'high' ? val : settings.high;
    audioService.setEqGains(nextLow, nextMid, nextHigh);
    setSettings(prev => ({ ...prev, [band]: val }));
  };

  const handleLofiToggle = useCallback(() => {
    const next = !lofiEnabled;
    setLofiEnabled(next);
    audioService.setLofiEnabled(next);
  }, [lofiEnabled]);

  const handleLofiDrive = useCallback((v: number) => {
    setLofiDrive(v);
    audioService.setLofiParams({ drive: v });
  }, []);

  const handleLofiTape = useCallback((v: number) => {
    setLofiTape(v);
    audioService.setLofiParams({ tape: v });
  }, []);

  const handleLofiCrush = useCallback((v: number) => {
    setLofiCrush(v);
    audioService.setLofiParams({ crush: v });
  }, []);

  const refreshBank = useCallback(() => {
    setBank(audioService.getBankSnapshot());
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length) {
      const { startIndex, overwrite } = sampleLoadRef.current;
      await audioService.primeFromGesture();
      await audioService.loadSampleFiles(e.target.files, startIndex, { overwrite });
      refreshBank();
      e.target.value = '';
      sampleLoadRef.current = { startIndex: 0, overwrite: false };
    }
  };
  const prepareSampleLoad = (startIndex: number, overwrite: boolean, disabled?: boolean) => (e: React.SyntheticEvent) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    sampleLoadRef.current = { startIndex, overwrite };
  };

  const handleRecordPointerDown = (slot?: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    void handleRecordToggle(slot);
  };

  const handleClearMicSlot = (slot: number) => {
    audioService.clearMicSlot(slot);
    refreshBank();
  };

  const handleClearSampleSlot = (slot: number) => {
    audioService.clearSampleSlot(slot);
    refreshBank();
  };

  const toggleSynth = () => {
    audioService.setSynthEnabled(!bank.synthEnabled);
    refreshBank();
  };

  const pickMimeType = () => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  };

  const stopFallbackRecording = async () => {
    const fallback = fallbackRecorderRef.current;
    if (!fallback) return;
    fallbackRecorderRef.current = null;
    if (recorderTimerRef.current) {
      clearTimeout(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
    try {
      fallback.processor.disconnect();
      fallback.source.disconnect();
      fallback.silent.disconnect();
      await fallback.ctx.close();
    } catch {
      // ignore
    }
    setIsRecording(false);
    const blob = encodeWav(fallback.buffers, fallback.sampleRate);
    const stored = await audioService.loadMicSampleBlob(blob, recordSlotRef.current ?? undefined);
    recordSlotRef.current = null;
    if (stored) refreshBank();
  };

  const startFallbackRecording = async (stream: MediaStream) => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    const buffers: Float32Array[] = [];

    processor.onaudioprocess = (ev) => {
      if (!fallbackRecorderRef.current) return;
      buffers.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };

    source.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);
    try { await ctx.resume(); } catch { /* ignore */ }

    fallbackRecorderRef.current = {
      ctx,
      source,
      processor,
      silent,
      buffers,
      sampleRate: ctx.sampleRate,
    };

    recorderTimerRef.current = window.setTimeout(() => {
      if (fallbackRecorderRef.current) void stopFallbackRecording();
    }, MAX_RECORD_MS);
    setIsRecording(true);
  };

  const handleRecordToggle = async (slot?: number) => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      if (recorderTimerRef.current) {
        clearTimeout(recorderTimerRef.current);
        recorderTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }
    if (fallbackRecorderRef.current) {
      await stopFallbackRecording();
      return;
    }

    const hasTargetSlot = typeof slot === 'number';
    if (!hasTargetSlot && audioService.isMicBankFull()) {
      return;
    }

    try {
      recordSlotRef.current = hasTargetSlot ? slot : null;
      await audioService.primeFromGesture();
      await audioService.ensureMic({ fromUserGesture: true });
      audioService.setMicGain(micGain);
      const stream = audioService.getMicRecordStream();
      if (!stream) {
        recordSlotRef.current = null;
        console.error('Recording not supported in this browser/environment.');
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        await startFallbackRecording(stream);
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      recorderChunks.current = [];

      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recorderChunks.current.push(ev.data);
      };
      rec.onstop = async () => {
        setIsRecording(false);
        const blobType = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(recorderChunks.current, { type: blobType });
        recorderChunks.current = [];
        if (recorderTimerRef.current) {
          clearTimeout(recorderTimerRef.current);
          recorderTimerRef.current = null;
        }
        const stored = await audioService.loadMicSampleBlob(blob, recordSlotRef.current ?? undefined);
        recordSlotRef.current = null;
        if (stored) refreshBank();
      };

      rec.start();
      recorderTimerRef.current = window.setTimeout(() => {
        if (rec.state === 'recording') {
          rec.stop();
        }
      }, MAX_RECORD_MS);
      setIsRecording(true);
    } catch (err) {
      recordSlotRef.current = null;
      console.error('Recording failed', err);
    }
  };

  useEffect(() => {
    void audioService.ensureMic();
    audioService.setMicGain(2.6);
    const peakCtx = peakCanvasRef.current?.getContext('2d');
    const mainCtx = mainCanvasRef.current?.getContext('2d');
    const micCtx = micVURef.current?.getContext('2d');
    if (!peakCtx || !mainCtx) return;

    const drawVU = () => {
      const renderVU = (ctx: CanvasRenderingContext2D, db: number) => {
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        ctx.clearRect(0, 0, width, height);
        const top = TRACK_TOP;
        const bottom = TRACK_BOTTOM;
        const innerH = Math.max(1, height - top - bottom);
        ctx.fillStyle = 'rgba(185, 188, 183, 0.3)';
        ctx.fillRect(0, top, width, innerH);
        const minDb = -40;
        const maxDb = 0;
        const percent = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
        let color = '#7A8476';
        if (db > -1.5) color = '#3F453F';
        const barHeight = innerH * percent;
        ctx.fillStyle = color;
        ctx.fillRect(0, top + (innerH - barHeight), width, barHeight);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 1; i < 10; i++) ctx.fillRect(0, top + innerH * (i / 10), width, 1);
      };

      const peakDb = audioService.getPeakLevel();
      const mainDb = audioService.getMainLevel();
      renderVU(peakCtx, peakDb);
      renderVU(mainCtx, mainDb);
      if (micCtx) renderVU(micCtx, audioService.getMicLevelDb());

      const now = performance.now();
      if (now - lofiLevelUpdateRef.current > 120) {
        lofiLevelUpdateRef.current = now;
        setLofiLevel(dbToLevel(mainDb));
      }

      animationRef.current = requestAnimationFrame(drawVU);
    };

    animationRef.current = requestAnimationFrame(drawVU);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  const micFull = bank.mic.every(Boolean);
  const smpFull = bank.smp.every(Boolean);
  const isRecorderActive = isRecording || recorderRef.current?.state === 'recording' || Boolean(fallbackRecorderRef.current);
  const recordDisabled = micFull && !isRecorderActive;
  const formatSlots = (slots: boolean[]) => {
    const ids = slots
      .map((hasSample, idx) => (hasSample ? String(idx + 1).padStart(2, '0') : null))
      .filter(Boolean) as string[];
    return ids.length ? ids.join('|') : '--';
  };
  const loadedSummary = `S:${formatSlots(bank.smp)} M:${formatSlots(bank.mic)}${bank.synthEnabled ? ' SYNTH' : ''}`;
  const marqueeStyle = loadedShift > 0
    ? ({
        '--loaded-shift': `${loadedShift}px`,
        animation: `loaded-marquee ${loadedDuration}s ease-in-out infinite`,
        willChange: 'transform',
      } as React.CSSProperties)
    : undefined;

  useEffect(() => {
    const measure = () => {
      const wrap = loadedWrapRef.current;
      const text = loadedTextRef.current;
      if (!wrap || !text) return;
      const shift = Math.max(0, text.scrollWidth - wrap.clientWidth);
      setLoadedShift(shift);
      const duration = shift > 0 ? Math.min(20, Math.max(8, shift / 10)) : 0;
      setLoadedDuration(duration);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [loadedSummary]);

  return (
    <div className="w-full max-w-6xl mx-auto bg-[#D9DBD6] border border-[#B9BCB7] rounded-3xl p-4 lg:p-2 shadow-lg relative isolate mt-6 mb-3 text-[#5F665F] font-mono tracking-widest select-none h-auto transition-all">
      <style>{`
        @keyframes loaded-marquee {
          0% { transform: translateX(0); }
          50% { transform: translateX(calc(-1 * var(--loaded-shift))); }
          100% { transform: translateX(0); }
        }
        .lofi-knob > div:last-child > span:last-child {
          display: none;
        }
      `}</style>
      <div className="flex items-center gap-2 text-[10px] text-[#7A8476] h-4 pl-2 mb-2">
        <Sliders size={12} /> MASTER CONTROL
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-[1.10fr_0.70fr_0.90fr_0.90fr_1.40fr]">
        {/* TRANSPORT */}
        <div className="col-span-2 lg:col-span-1 min-w-0 bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-3 grid gap-2 overflow-hidden" style={{ gridTemplateRows: '16px auto' }}>
          <div className="h-4 text-[#7A8476] leading-none flex items-center justify-center" title="Transport">
            <Bus size={14} />
            <span className="sr-only">Transport</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center justify-center gap-1">
              <button
                onClick={onPlayPause}
                className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center transition-all shadow-sm ${isPlaying ? 'bg-[#7A8476] text-[#F2F2F0]' : 'bg-[#7A8476] text-[#F2F2F0] hover:bg-[#5F665F]'}`}
              >
                {isPlaying ? <Pause size={14} className="fill-current" /> : <Play size={14} className="fill-current ml-0.5" />}
              </button>
              <button
                onClick={onStop}
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full border border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] flex items-center justify-center hover:bg-[#B9BCB7] transition-all"
              >
                <Square size={14} className="fill-current" />
              </button>
              <button
                onClick={handleRecordToggle}
                onPointerDown={handleRecordPointerDown()}
                disabled={recordDisabled}
                className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full border ${isRecording ? 'border-[#7A8476] bg-[#7A8476] text-[#F2F2F0]' : 'border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] hover:bg-[#B9BCB7]'} flex items-center justify-center transition-all ${recordDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                title={isRecording ? 'Stop recording' : 'Record sample (max 10s)'}
              >
                <Mic2 size={14} className="fill-current" />
              </button>
            </div>
            <div className="w-full h-px bg-[#B9BCB7] opacity-60" />
            <div className="relative w-full" style={{ aspectRatio: '95 / 60' }}>
              <BulbIcon className="absolute top-[38%] left-[14%] -translate-x-1/2 -translate-y-1/2 w-4 h-4 text-[#7A8476] pointer-events-none" />
              <TapeCassette
                enabled={lofiEnabled}
                tape={lofiTape}
                level={lofiLevel}
                className="absolute inset-0 w-full h-full text-[#7A8476] pointer-events-none"
              />
              <div className="absolute inset-x-4 top-[84%] -translate-y-1/3 flex items-end justify-center">
                <div className="flex items-end justify-center gap-2">
                  <div className="px-0.5 rounded-md border border-[#B9BCB7] bg-[#E7E8E5]/70 backdrop-blur-sm" style={{ paddingTop: '0.01rem', paddingBottom: '0.01rem' }}>
                    <BufferedKnob
                      value={lofiDrive}
                      onCommit={handleLofiDrive}
                      min={0}
                      max={1}
                      defaultValue={0}
                      size={26}
                      color="#7A8476"
                      label="DRIVE"
                      format={() => ''}
                      className="lofi-knob"
                      live
                    />
                  </div>
                  <div className="px-0.5 rounded-md border border-[#B9BCB7] bg-[#E7E8E5]/70 backdrop-blur-sm" style={{ paddingTop: '0.01rem', paddingBottom: '0.01rem' }}>
                    <BufferedKnob
                      value={lofiTape}
                      onCommit={handleLofiTape}
                      min={0}
                      max={1}
                      defaultValue={0}
                      size={26}
                      color="#7A8476"
                      label="TAPE"
                      format={() => ''}
                      className="lofi-knob"
                      live
                    />
                  </div>
                  <div className="px-0.5 rounded-md border border-[#B9BCB7] bg-[#E7E8E5]/70 backdrop-blur-sm" style={{ paddingTop: '0.01rem', paddingBottom: '0.01rem' }}>
                    <BufferedKnob
                      value={lofiCrush}
                      onCommit={handleLofiCrush}
                      min={0}
                      max={1}
                      defaultValue={0}
                      size={26}
                      color="#7A8476"
                      label="CRUSH"
                      format={() => ''}
                      className="lofi-knob"
                      live
                    />
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLofiToggle}
                aria-pressed={lofiEnabled}
                className={`absolute left-[86%] top-[38%] -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border transition-colors ${lofiEnabled ? 'bg-[#7A8476] border-[#7A8476]' : 'bg-[#D9DBD6] border-[#B9BCB7]'}`}
                title={lofiEnabled ? 'LO-FI on' : 'LO-FI off'}
              />
            </div>
          </div>
        </div>

        {/* MIC */}
        <div className="min-w-0 bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-3 grid gap-1" style={{ gridTemplateRows: '16px 1fr' }}>
          <div className="h-4 text-[#7A8476] leading-none flex items-center justify-center" title="Mic">
            <Mic2 size={14} />
            <span className="sr-only">Mic</span>
          </div>
          <div className="grid grid-cols-2 justify-items-center items-center" style={{ height: CONTROL_ZONE_H }}>
            <ControlColumn label="Gain" bottom={`${(micGain * 25).toFixed(0)}%`}>
              <Fader
                value={micGain}
                min={0}
                max={4}
                defaultValue={2.6}
                onChange={(v) => {
                  if (!audioService.getMicStream()) void audioService.ensureMic({ fromUserGesture: true });
                  setMicGain(v);
                  audioService.setMicGain(v);
                }}
              />
            </ControlColumn>
            <ControlColumn label="VU" bottom="dB">
              <canvas ref={micVURef} width={FADER_TRACK_W} height={FADER_HEIGHT} className="rounded-sm bg-black/5" style={{ height: FADER_HEIGHT, width: FADER_TRACK_W }} />
            </ControlColumn>
          </div>
        </div>

        {/* OUT */}
        <div className="min-w-0 bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-3 grid gap-1" style={{ gridTemplateRows: '16px 1fr' }}>
          <div className="h-4 text-[#7A8476] leading-none flex items-center justify-center" title="Out">
            <Headphones size={14} />
            <span className="sr-only">Out</span>
          </div>
          <div className="grid grid-cols-3 justify-items-center items-center" style={{ height: CONTROL_ZONE_H }}>
            <ControlColumn label="Peak" bottom="dB">
              <canvas ref={peakCanvasRef} width={FADER_TRACK_W} height={FADER_HEIGHT} className="rounded-sm bg-black/5" style={{ height: FADER_HEIGHT, width: FADER_TRACK_W }} />
            </ControlColumn>
            <ControlColumn label="Main" bottom="dB">
              <canvas ref={mainCanvasRef} width={FADER_TRACK_W} height={FADER_HEIGHT} className="rounded-sm bg-black/5" style={{ height: FADER_HEIGHT, width: FADER_TRACK_W }} />
            </ControlColumn>
            <ControlColumn label="Level" bottom={`${(settings.volume * 100).toFixed(0)}%`}>
              <Fader
                value={settings.volume}
                min={0}
                max={1}
                defaultValue={0.7}
                onChange={(v) => {
                  audioService.setMasterGain(v);
                  setSettings(p => ({ ...p, volume: v }));
                }}
              />
            </ControlColumn>
          </div>
        </div>

        {/* EQ */}
        <div className="min-w-0 bg-[#E4E5E2] rounded-2xl border border-[#C7C9C5] p-3 grid gap-1 shadow-inner" style={{ gridTemplateRows: '16px 1fr' }}>
          <div className="h-4 text-[#7A8476] leading-none flex items-center justify-center" title="EQ">
            <Brush size={14} />
            <span className="sr-only">EQ</span>
          </div>
          <div className="grid grid-cols-3 justify-items-center items-center" style={{ height: CONTROL_ZONE_H }}>
            {(['low', 'mid', 'high'] as const).map((band) => (
              <ControlColumn key={band} label={band} bottom={`${(settings[band] as number).toFixed(1)}dB`}>
                <Fader
                  value={settings[band] as number}
                  min={-24}
                  max={24}
                  defaultValue={0}
                  onChange={(v) => handleEQChange(band, v)}
                />
              </ControlColumn>
            ))}
          </div>
        </div>

        {/* DATA */}
        <div className="col-span-2 lg:col-span-1 min-w-0 bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-3 grid gap-1 justify-center" style={{ gridTemplateRows: '16px 1fr' }}>
          <div className="h-4 text-[#7A8476] leading-none flex items-center justify-center" title="Data">
            <Book size={14} />
            <span className="sr-only">Data</span>
          </div>
          <div className="flex flex-col items-start gap-[4px]" style={{ height: CONTROL_ZONE_H }}>
            <div className="w-full max-w-[260px]">
              <div className="w-[240px] min-w-[240px] max-w-[240px] shrink-0 px-1 py-0.5 bg-[#F2F2F0] border border-[#B9BCB7] rounded-full shadow-inner text-[9px] uppercase tracking-widest text-[#5F665F] flex items-center gap-2 overflow-hidden">
                <Database size={12} className="opacity-80" />
                <div ref={loadedWrapRef} className="flex-1 min-w-0 overflow-hidden whitespace-nowrap leading-none">
                  <span ref={loadedTextRef} className="inline-block pr-2" style={marqueeStyle}>{loadedSummary}</span>
                </div>
              </div>
            </div>

            <div className="w-full max-w-[260px] grid items-center gap-x-1 h-[16px]" style={{ gridTemplateColumns: DATA_GRID_COLS }}>
              <div className="col-start-1 flex items-center h-[16px] text-[9px] uppercase tracking-widest text-[#7A8476]">
                <button
                  type="button"
                  onClick={toggleSynth}
                  className={`w-full h-[16px] rounded-full border text-[9px] leading-none tracking-widest text-center ${bank.synthEnabled ? 'bg-[#7A8476] text-white border-[#7A8476]' : 'border-[#B9BCB7] text-[#5F665F] bg-[#F2F2F0]'}`}
                >
                  {bank.synthEnabled ? 'SYNTH ON' : 'SYNTH OFF'}
                </button>
              </div>
              <div className="col-start-3 flex items-center h-[16px]">
                <label
                  htmlFor={sampleInputId}
                  role="button"
                  tabIndex={smpFull ? -1 : 0}
                  onPointerDown={prepareSampleLoad(0, false, smpFull)}
                  onClick={prepareSampleLoad(0, false, smpFull)}
                  aria-disabled={smpFull}
                  className={`w-full h-[16px] rounded-full border text-[9px] uppercase tracking-widest leading-none transition-all flex items-center justify-center ${
                    smpFull ? 'border-[#D9DBD6] text-[#C7C9C5] bg-[#F2F2F0] cursor-not-allowed' : 'border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] hover:bg-white'
                  }`}
                >
                  Load Samples
                </label>
              </div>
            </div>

            <div className="w-full max-w-[260px] flex-1 min-h-0 relative z-0">
              <div className="grid content-start gap-x-1 gap-y-[4px]" style={{ gridTemplateColumns: DATA_GRID_COLS, gridTemplateRows: 'repeat(6, 16px)' }}>
                {bank.mic.map((hasMic, idx) => {
                  const hasSmp = bank.smp[idx];
                  return (
                    <React.Fragment key={`row-${idx}`}>
                      <button
                        type="button"
                        onClick={() => handleRecordToggle(idx)}
                        onPointerDown={handleRecordPointerDown(idx)}
                        className={`w-full h-[16px] rounded-full border px-3 flex items-center justify-center text-[9px] tracking-widest uppercase leading-none transition-all ${
                          hasMic ? 'bg-[#7A8476] text-[#F2F2F0] border-[#7A8476]' : 'bg-[#F2F2F0] text-[#5F665F] border-[#B9BCB7] hover:bg-white'
                        }`}
                      >
                        MIC0{idx + 1}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleClearMicSlot(idx)}
                        disabled={!hasMic}
                        className={`h-[16px] w-[16px] rounded-full border flex items-center justify-center transition-all ${
                          hasMic ? 'bg-[#F2F2F0] border-[#B9BCB7] hover:bg-[#E7E8E5]' : 'border-[#D9DBD6] text-[#C7C9C5] cursor-not-allowed opacity-50'
                        }`}
                      >
                        <XCircle size={9} />
                      </button>
                      <label
                        htmlFor={sampleInputId}
                        role="button"
                        tabIndex={0}
                        onPointerDown={prepareSampleLoad(idx, true)}
                        onClick={prepareSampleLoad(idx, true)}
                        className={`w-full h-[16px] rounded-full border px-3 flex items-center justify-center text-[9px] tracking-widest uppercase leading-none transition-all ${
                          hasSmp ? 'bg-[#7A8476] text-[#F2F2F0] border-[#7A8476]' : 'bg-[#F2F2F0] text-[#5F665F] border-[#B9BCB7] hover:bg-white'
                        }`}
                      >
                        SMP0{idx + 1}
                      </label>
                      <button
                        type="button"
                        onClick={() => handleClearSampleSlot(idx)}
                        disabled={!hasSmp}
                        className={`h-[16px] w-[16px] rounded-full border flex items-center justify-center transition-all ${
                          hasSmp ? 'bg-[#F2F2F0] border-[#B9BCB7] hover:bg-[#E7E8E5]' : 'border-[#D9DBD6] text-[#C7C9C5] cursor-not-allowed opacity-50'
                        }`}
                      >
                        <XCircle size={9} />
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            <input
              id={sampleInputId}
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              multiple
              className="absolute opacity-0 w-px h-px overflow-hidden pointer-events-none"
              onChange={handleFileUpload}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
