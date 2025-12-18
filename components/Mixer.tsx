import React, { useRef, useEffect, useState } from 'react';
import { AudioSettings } from '../types';
import { Play, Pause, Square, Upload, Sliders, Circle, Mic2, XCircle } from 'lucide-react';
import { audioService } from '../services/audioEngine';
import { BufferedKnob } from './BufferedKnob';

interface MixerProps {
  settings: AudioSettings;
  setSettings: React.Dispatch<React.SetStateAction<AudioSettings>>;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
}

type FaderProps = {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  height?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
};

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

const TRACK_TOP = 8;
const TRACK_BOTTOM = 8;
const THUMB_RADIUS = 8;
const HITBOX_MIN_W = 32;
const FADER_DEFAULT_H = 200;

const Fader: React.FC<FaderProps> = ({ value, min, max, defaultValue, height = FADER_DEFAULT_H, onChange, disabled }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    pointerId: -1,
    startY: 0,
    startVal: 0,
    moved: false,
    lastUpAt: 0,
    lastUpX: 0,
    lastUpY: 0,
  });

  const toRatio = (val: number) => (val - min) / (max - min || 1);
  const fromRatio = (t: number) => min + t * (max - min);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    stateRef.current.pointerId = e.pointerId;
    stateRef.current.startY = e.clientY;
    stateRef.current.startVal = value;
    stateRef.current.moved = false;
    stateRef.current.lastUpAt = stateRef.current.lastUpAt || 0;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== stateRef.current.pointerId) return;
      ev.preventDefault();
      const dy = stateRef.current.startY - ev.clientY; // up = positive
      const travel = height - TRACK_TOP - TRACK_BOTTOM - (THUMB_RADIUS * 2);
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
      const dx = ev.clientX - stateRef.current.startY; // not used
      const dist = Math.hypot(ev.clientX - stateRef.current.startY, ev.clientY - stateRef.current.startY);
      const dt = now - stateRef.current.lastUpAt;
      const isDouble = dist < 4 && dt < 300 && !stateRef.current.moved;
      if (isDouble) {
        onChange(defaultValue);
        stateRef.current.lastUpAt = 0;
      } else {
        stateRef.current.lastUpAt = now;
        stateRef.current.lastUpX = ev.clientX;
        stateRef.current.lastUpY = ev.clientY;
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

  const ratio = toRatio(value);
  const travel = height - TRACK_TOP - TRACK_BOTTOM - THUMB_RADIUS * 2;
  const thumbBottom = TRACK_BOTTOM + ratio * travel;
  return (
    <div className="relative flex items-center justify-center" style={{ height, width: 40 }}>
      <div
        ref={trackRef}
        className="pointer-events-none absolute"
        style={{ top: TRACK_TOP, bottom: TRACK_BOTTOM, left: '50%', transform: 'translateX(-50%)', width: 6, backgroundColor: '#B9BCB7', borderRadius: 999 }}
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

export const Mixer: React.FC<MixerProps> = ({ settings, setSettings, isPlaying, onPlayPause, onStop }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const peakCanvasRef = useRef<HTMLCanvasElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunks = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderTimerRef = useRef<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState<boolean>(audioService.isSampleLoaded());
  const micVURef = useRef<HTMLCanvasElement>(null);
  const [micGain, setMicGain] = useState(1);
  const [sourceMode, setSourceMode] = useState<'mic' | 'sample'>(sampleLoaded ? 'sample' : 'mic');

  const handleEQChange = (band: 'low' | 'mid' | 'high', val: number) => {
    // Val is 0-100 from range input, map to -10 to 10 dB
    const db = (val - 50) / 5; 
    setSettings(prev => ({ ...prev, [band]: db }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      audioService.loadSample(e.target.files[0]).then(() => setSampleLoaded(audioService.isSampleLoaded()));
    }
  };

  const handleRecordToggle = async () => {
    if (isRecording && recorderRef.current) {
      recorderRef.current.stop();
      if (recorderTimerRef.current) {
        clearTimeout(recorderTimerRef.current);
        recorderTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      recorderChunks.current = [];

      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recorderChunks.current.push(ev.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(recorderChunks.current, { type: 'audio/webm' });
        recorderChunks.current = [];
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (recorderTimerRef.current) {
          clearTimeout(recorderTimerRef.current);
          recorderTimerRef.current = null;
        }
        await audioService.loadSampleBlob(blob);
        setSampleLoaded(audioService.isSampleLoaded());
      };

      rec.start();
      recorderTimerRef.current = window.setTimeout(() => {
        if (rec.state === 'recording') {
          rec.stop();
        }
      }, 10000); // hard cap 10s
      setIsRecording(true);
    } catch (err) {
      console.error('Recording failed', err);
    }
  };

  const handleClearSample = () => {
    audioService.clearSample();
    setSampleLoaded(false);
  };

  useEffect(() => {
    // prime mic for VU even when not playing
    void audioService.ensureMic();
    audioService.setMicGain(1);
    const peakCtx = peakCanvasRef.current?.getContext('2d');
    const mainCtx = mainCanvasRef.current?.getContext('2d');
    const micCtx = micVURef.current?.getContext('2d');
    if (!peakCtx || !mainCtx) return;

    const drawVU = () => {
      const renderVU = (ctx: CanvasRenderingContext2D, db: number) => {
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(185, 188, 183, 0.3)';
        ctx.fillRect(0, 0, width, height);
        const minDb = -40;
        const maxDb = 0;
        const percent = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
        let color = '#7A8476';
        if (db > -1.5) color = '#3F453F';
        const barHeight = height * percent;
        ctx.fillStyle = color;
        ctx.fillRect(0, height - barHeight, width, barHeight);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 1; i < 10; i++) ctx.fillRect(0, height * (i / 10), width, 1);
      };

      renderVU(peakCtx, audioService.getPeakLevel());
      renderVU(mainCtx, audioService.getMainLevel());
      if (micCtx) {
        renderVU(micCtx, audioService.getMicLevelDb());
      }

      animationRef.current = requestAnimationFrame(drawVU);
    };

    animationRef.current = requestAnimationFrame(drawVU);

    return () => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Standard style for vertical range inputs
  const verticalRangeStyle: React.CSSProperties = {
    writingMode: 'vertical-lr',
    direction: 'rtl', 
    appearance: 'auto',
    width: '100%' // Helps align hit area in some browsers
  };

  return (
    <div className="w-full max-w-5xl mx-auto bg-[#D9DBD6] border border-[#B9BCB7] rounded-3xl p-6 shadow-lg relative mt-6 mb-14 text-[#5F665F] font-mono tracking-widest select-none h-auto transition-all">
      <div className="absolute top-4 left-6 text-[10px] text-[#7A8476] flex items-center gap-2">
        <Sliders size={12} /> MASTER CONTROL
      </div>

      <div className="flex flex-col gap-4">
        {/* Section row */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          
          {/* TRANSPORT */}
          <div className="bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-4 flex flex-col items-center gap-4">
            <div className="text-[10px] uppercase tracking-widest text-[#7A8476]">Transport</div>
            <div className="flex items-center gap-4">
              <button 
                onClick={onPlayPause}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-sm ${isPlaying ? 'bg-[#7A8476] text-[#F2F2F0]' : 'bg-[#7A8476] text-[#F2F2F0] hover:bg-[#5F665F]'}`}
              >
                {isPlaying ? <Pause size={24} className="fill-current" /> : <Play size={24} className="fill-current ml-1" />}
              </button>
              <button 
                onClick={onStop}
                className="w-16 h-16 rounded-full border border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] flex items-center justify-center hover:bg-[#B9BCB7] transition-all"
              >
                <Square size={20} className="fill-current" />
              </button>
            </div>
          </div>

          {/* SOURCE / INPUT */}
          <div className="bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest text-[#7A8476]">Source / Input</div>
              <div className="flex gap-2">
                <button
                  className={`px-3 py-1 rounded-full text-[10px] uppercase border ${sourceMode === 'mic' ? 'bg-[#7A8476] text-white border-[#7A8476]' : 'border-[#B9BCB7] text-[#5F665F]'}`}
                  onClick={() => setSourceMode('mic')}
                >
                  Mic
                </button>
                <button
                  className={`px-3 py-1 rounded-full text-[10px] uppercase border ${sourceMode === 'sample' ? 'bg-[#7A8476] text-white border-[#7A8476]' : 'border-[#B9BCB7] text-[#5F665F]'} ${!sampleLoaded ? 'opacity-50 cursor-not-allowed' : ''}`}
                  onClick={() => sampleLoaded && setSourceMode('sample')}
                >
                  Sample
                </button>
              </div>
            </div>

            <div className="flex items-start gap-6">
              <div className="flex flex-col items-center gap-2">
                <div className="text-[9px] uppercase text-[#7A8476]">Mic Gain</div>
                <Fader
                  value={micGain}
                  min={0}
                  max={4}
                  defaultValue={1}
                  onChange={(v) => {
                    setMicGain(v);
                    audioService.setMicGain(v);
                  }}
                  disabled={sourceMode !== 'mic'}
                />
                <canvas ref={micVURef} width={10} height={160} className="rounded-sm bg-black/5 h-40 w-2.5" />
              </div>

              <div className="flex flex-col items-center gap-2">
                <div className="text-[9px] uppercase text-[#7A8476]">Sample Gain</div>
                <Fader
                  value={settings.sampleGain ?? 1}
                  min={0}
                  max={2}
                  defaultValue={1}
                  onChange={(v) => setSettings(p => ({ ...p, sampleGain: v }))}
                  disabled={sourceMode !== 'sample'}
                />
                <div className="text-[10px] text-[#5F665F]">{(settings.sampleGain ?? 1).toFixed(2)}</div>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 bg-[#F2F2F0] border border-[#B9BCB7] rounded-lg hover:bg-white transition-all text-[10px] uppercase font-bold shadow-sm"
                >
                  <Upload size={12} />
                  Load
                </button>
                <input 
                  ref={fileInputRef}
                  type="file" 
                  accept="audio/*" 
                  className="hidden" 
                  onChange={handleFileUpload}
                />
              </div>

              <div className="flex flex-col items-center gap-2 flex-1">
                <div className="flex justify-between w-full text-[8px] opacity-70 uppercase">
                  <span>Freq</span>
                  <span>{settings.baseFrequency}Hz</span>
                </div>
                <input 
                  type="range"
                  min="100"
                  max="880"
                  value={settings.baseFrequency}
                  onChange={(e) => setSettings(p => ({ ...p, baseFrequency: parseFloat(e.target.value) }))}
                  className="w-full h-1 bg-[#B9BCB7] rounded-full accent-[#7A8476] cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* CHANNEL STRIP */}
          <div className="bg-[#D9DBD6] rounded-2xl border border-[#C7C9C5] p-4 flex flex-col items-center gap-3">
            <div className="text-[10px] uppercase tracking-widest text-[#7A8476]">Channel</div>
            <div className="flex items-end gap-4">
              <div className="flex flex-col items-center gap-1">
                <span className="text-[8px] uppercase opacity-60">Peak</span>
                <canvas ref={peakCanvasRef} width={10} height={160} className="rounded-sm bg-black/5 h-40 w-2.5" />
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-[8px] uppercase opacity-60">Main</span>
                <canvas ref={mainCanvasRef} width={10} height={160} className="rounded-sm bg-black/5 h-40 w-2.5" />
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-[8px] uppercase opacity-60">Level</span>
                <Fader
                  value={settings.volume}
                  min={0}
                  max={1}
                  defaultValue={0.7}
                  onChange={(v) => setSettings(p => ({ ...p, volume: v }))}
                />
              </div>
            </div>
          </div>

          {/* MASTER */}
          <div className="bg-[#E4E5E2] rounded-2xl border border-[#C7C9C5] p-4 flex flex-col items-center gap-3 shadow-inner">
            <div className="text-[10px] uppercase tracking-widest text-[#7A8476]">Master</div>
            <div className="flex items-end gap-4">
              {['low', 'mid', 'high'].map((band) => (
                <div key={band} className="flex flex-col items-center gap-1">
                  <div className="text-[8px] uppercase opacity-60">{band}</div>
                  <div className="h-40 flex justify-center relative w-10">
                    <div className="absolute inset-y-0 w-2 bg-[#D9DBD6] rounded-full left-1/2 -translate-x-1/2"></div>
                    <input 
                      type="range" 
                      min="-10" 
                      max="10" 
                      step="0.5" 
                      value={settings[band as keyof AudioSettings] as number}
                      onChange={(e) => handleEQChange(band as any, parseFloat(e.target.value))}
                      className="h-full w-6 opacity-0 cursor-pointer absolute z-10"
                      style={verticalRangeStyle}
                    />
                    <div 
                      className="absolute w-4 h-4 bg-[#5F665F] rounded-full shadow-sm left-1/2 -translate-x-1/2 pointer-events-none transition-transform duration-75"
                      style={{ bottom: `calc(${(((settings[band as keyof AudioSettings] as number) + 10) / 20) * 100}% - 8px)` }}
                    ></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
