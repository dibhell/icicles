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

      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between gap-6">
          {/* Left cluster: status/clear + transport + mic */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-[#7A8476]">{sampleLoaded ? 'Sample Loaded' : 'Default Synth'}</span>
              <button 
                onClick={handleClearSample}
                className="flex items-center gap-2 px-3 py-2 bg-[#F2F2F0] border border-[#B9BCB7] rounded-lg hover:bg-white transition-all text-[10px] uppercase font-bold shadow-sm disabled:opacity-40"
                disabled={!sampleLoaded}
              >
                <XCircle size={14} />
                Clear
              </button>
            </div>

            <div className="flex items-center gap-4">
              <button 
                onClick={onPlayPause}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-sm
                  ${isPlaying ? 'bg-[#7A8476] text-[#F2F2F0]' : 'bg-[#7A8476] text-[#F2F2F0] hover:bg-[#5F665F]'}`}
              >
                {isPlaying ? <Pause size={24} className="fill-current" /> : <Play size={24} className="fill-current ml-1" />}
              </button>
              
              <button 
                onClick={onStop}
                className="w-16 h-16 rounded-full border border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] flex items-center justify-center hover:bg-[#B9BCB7] transition-all"
              >
                <Square size={20} className="fill-current" />
              </button>

              <button
                onClick={handleRecordToggle}
                className={`w-16 h-16 rounded-full border ${isRecording ? 'border-[#7A8476] bg-[#7A8476] text-[#F2F2F0]' : 'border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] hover:bg-[#B9BCB7]'} flex items-center justify-center transition-all`}
                title={isRecording ? 'Stop recording' : 'Record sample (max 10s)'}
              >
                <Mic2 size={20} className="fill-current" />
              </button>

              <canvas ref={micVURef} width={6} height={96} className="rounded-sm bg-black/5 h-24 w-2" />
            </div>

            <div className="flex items-center gap-2 pl-1">
              <span className="text-[8px] uppercase opacity-70">Mic Gain</span>
              <input
                type="range"
                min="0"
                max="4"
                step="0.05"
                value={micGain}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setMicGain(v);
                  audioService.setMicGain(v);
                }}
                onPointerDown={() => audioService.ensureMic()}
                className="w-28 accent-[#7A8476]"
              />
            </div>
          </div>

          {/* Center cluster: load + freq + sample gain */}
          <div className="flex flex-col items-center gap-3">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 md:py-2 bg-[#F2F2F0] border border-[#B9BCB7] rounded-lg hover:bg-white transition-all text-[10px] uppercase font-bold shadow-sm"
            >
              <Upload size={12} />
              Load Sample
            </button>
            <input 
              ref={fileInputRef}
              type="file" 
              accept="audio/*" 
              className="hidden" 
              onChange={handleFileUpload}
            />
            <div className="flex flex-col items-center gap-2">
              <div className="flex justify-between w-44 text-[8px] opacity-70 uppercase">
                <span>Freq</span>
                <span>{settings.baseFrequency}Hz</span>
              </div>
              <input 
                type="range"
                min="100"
                max="880"
                value={settings.baseFrequency}
                onChange={(e) => setSettings(p => ({ ...p, baseFrequency: parseFloat(e.target.value) }))}
                className="w-44 h-1 bg-[#B9BCB7] rounded-full accent-[#7A8476] cursor-pointer"
              />
              <div className="mt-2">
                <BufferedKnob
                  value={settings.sampleGain ?? 1}
                  onCommit={(v) => setSettings(p => ({ ...p, sampleGain: v }))}
                  min={0}
                  max={2}
                  defaultValue={1}
                  size={40}
                  color="#7A8476"
                  format={(v) => v.toFixed(2)}
                  label="Sample Gain"
                />
              </div>
            </div>
          </div>

          {/* Right cluster: meters + level + EQ */}
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center gap-1">
              <div className="grid grid-cols-3 gap-x-6 gap-y-1 h-32 items-end">
                <div className="text-[8px] opacity-60 text-center uppercase tracking-wider mb-auto pt-1">Peak</div>
                <div className="text-[8px] opacity-60 text-center uppercase tracking-wider mb-auto pt-1">Main</div>
                <div className="text-[10px] font-bold text-center uppercase tracking-wider mb-auto pt-1">Level</div>

                <div className="h-24 flex justify-center items-end">
                  <canvas ref={peakCanvasRef} width={6} height={96} className="rounded-sm bg-black/5 h-full w-2" />
                </div>
                <div className="h-24 flex justify-center items-end">
                  <canvas ref={mainCanvasRef} width={6} height={96} className="rounded-sm bg-black/5 h-full w-2" />
                </div>
                <div className="h-24 flex justify-center relative w-8">
                  <div className="absolute inset-y-0 w-1.5 bg-[#B9BCB7] rounded-full left-1/2 -translate-x-1/2"></div>
                  <input 
                    type="range" 
                    min="0" 
                    max="1" 
                    step="0.01" 
                    value={settings.volume} 
                    onChange={(e) => setSettings(p => ({ ...p, volume: parseFloat(e.target.value) }))}
                    className="h-full w-6 opacity-0 cursor-pointer absolute z-10"
                    style={verticalRangeStyle}
                  />
                  <div 
                    className="absolute w-4 h-4 bg-[#7A8476] rounded-full shadow-sm left-1/2 -translate-x-1/2 pointer-events-none transition-transform duration-75"
                    style={{ bottom: `calc(${settings.volume * 100}% - 8px)` }}
                  ></div>
                </div>
                <div className="text-[8px] opacity-60 text-center">dB</div>
                <div className="text-[8px] opacity-60 text-center">dB</div>
                <div className="text-[9px] text-center">{(settings.volume * 100).toFixed(0)}%</div>
              </div>
            </div>

            <div className="flex gap-4 px-4 bg-[#F2F2F0] py-4 rounded-xl border border-[#B9BCB7]/30 shadow-inner h-32 items-end justify-center">
              {['low', 'mid', 'high'].map((band) => (
                <div key={band} className="flex flex-col items-center gap-2 h-full justify-between">
                  <div className="h-24 w-2.5 bg-[#D9DBD6] rounded-full relative overflow-hidden group border border-[#B9BCB7]">
                    <div 
                      className={`absolute bottom-0 w-full bg-[#5F665F] rounded-b-full transition-all`} 
                      style={{ height: `${(settings[band as keyof AudioSettings] as number + 10) * 5}%` }} 
                    />
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={(settings[band as keyof AudioSettings] as number * 5) + 50} 
                      onChange={(e) => handleEQChange(band as any, parseFloat(e.target.value))}
                      onDoubleClick={() => setSettings((p) => ({ ...p, [band]: 0 }))}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      style={verticalRangeStyle} 
                    />
                  </div>
                  <span className="text-[8px] uppercase">{band}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
