import React, { useRef, useEffect } from 'react';
import { AudioSettings } from '../types';
import { Play, Pause, Square, Upload, Sliders } from 'lucide-react';
import { audioService } from '../services/audioEngine';

interface MixerProps {
  settings: AudioSettings;
  setSettings: React.Dispatch<React.SetStateAction<AudioSettings>>;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
}

export const Mixer: React.FC<MixerProps> = ({ settings, setSettings, isPlaying, onPlayPause, onStop }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vuCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  const handleEQChange = (band: 'low' | 'mid' | 'high', val: number) => {
    // Val is 0-100 from range input, map to -10 to 10 dB
    const db = (val - 50) / 5; 
    setSettings(prev => ({ ...prev, [band]: db }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      audioService.loadSample(e.target.files[0]);
    }
  };

  useEffect(() => {
    if (!vuCanvasRef.current) return;
    const ctx = vuCanvasRef.current.getContext('2d');
    if (!ctx) return;

    const drawVU = () => {
      const db = audioService.getPeakLevel();
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      
      // Clear
      ctx.clearRect(0, 0, width, height);
      
      // VU Meter Background
      ctx.fillStyle = 'rgba(185, 188, 183, 0.3)';
      ctx.fillRect(0, 0, width, height);

      const minDb = -40;
      const maxDb = 0;
      const percent = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
      
      // Colors from Palette
      let color = '#7A8476'; 
      if (db > -0.5) color = '#3F453F'; 

      const barHeight = height * percent;
      
      // Draw Bar
      ctx.fillStyle = color;
      ctx.fillRect(0, height - barHeight, width, barHeight);

      // Ticks
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for(let i=1; i<10; i++) {
          ctx.fillRect(0, height * (i/10), width, 1);
      }

      animationRef.current = requestAnimationFrame(drawVU);
    };

    animationRef.current = requestAnimationFrame(drawVU);

    return () => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto bg-[#D9DBD6] border border-[#B9BCB7] rounded-3xl p-6 shadow-lg relative mt-12 mb-20 text-[#5F665F] font-mono tracking-widest select-none">
      
      {/* Label Top Left */}
      <div className="absolute top-4 left-6 text-[10px] text-[#7A8476] flex items-center gap-2">
        <Sliders size={12} /> MASTER CONTROL
      </div>

      <div className="flex flex-row items-center justify-between h-40 pt-6 gap-2">
        
        {/* SECTION 1: TRANSPORT */}
        <div className="flex items-center gap-4 px-4">
            <button 
            onClick={onPlayPause}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-sm
              ${isPlaying ? 'bg-[#7A8476] text-[#F2F2F0]' : 'bg-[#7A8476] text-[#F2F2F0] hover:bg-[#5F665F]'}`}
            >
            {isPlaying ? <Pause size={24} className="fill-current" /> : <Play size={24} className="fill-current ml-1" />}
            </button>
            
            <button 
            onClick={onStop}
            className="w-14 h-14 rounded-full border border-[#B9BCB7] bg-[#F2F2F0] text-[#5F665F] flex items-center justify-center hover:bg-[#B9BCB7] transition-all"
            >
            <Square size={20} className="fill-current" />
            </button>
        </div>

        <div className="w-px h-16 bg-[#B9BCB7]/50"></div>

        {/* SECTION 2: VOLUME */}
        <div className="flex items-end gap-6 px-4 h-full pb-4">
             {/* Use a grid to ensure perfect horizontal alignment of tops and bottoms */}
             <div className="grid grid-cols-2 gap-x-6 gap-y-1 h-32 items-end">
                
                {/* Headers */}
                <div className="text-[8px] opacity-60 text-center uppercase tracking-wider mb-auto pt-1">Peak</div>
                <div className="text-[10px] font-bold text-center uppercase tracking-wider mb-auto pt-1">Main</div>

                {/* Meter & Slider - FIXED HEIGHT to ensure flush alignment */}
                <div className="h-24 flex justify-center">
                    <canvas ref={vuCanvasRef} width={6} height={96} className="rounded-sm bg-black/5 h-full w-2" />
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
                        style={{ appearance: 'slider-vertical' as any }}
                    />
                     {/* Custom Thumb Visual - Simple circle that moves */}
                     <div 
                        className="absolute w-4 h-4 bg-[#7A8476] rounded-full shadow-sm left-1/2 -translate-x-1/2 pointer-events-none transition-transform duration-75"
                        style={{ bottom: `calc(${settings.volume * 100}% - 8px)` }}
                     ></div>
                </div>

                {/* Footers */}
                <div className="text-[8px] opacity-60 text-center">dB</div>
                <div className="text-[9px] text-center">{(settings.volume * 100).toFixed(0)}%</div>

             </div>
        </div>

        <div className="w-px h-16 bg-[#B9BCB7]/50"></div>

        {/* SECTION 3: EQ */}
        <div className="flex gap-4 px-6 bg-[#F2F2F0] py-4 rounded-xl border border-[#B9BCB7]/30 shadow-inner h-32 items-end">
             {['low', 'mid', 'high'].map((band) => (
                <div key={band} className="flex flex-col items-center gap-2 h-full justify-between">
                     {/* Spacer for alignment with MAIN text if needed, or just justify-end */}
                    <div className="h-24 w-2.5 bg-[#D9DBD6] rounded-full relative overflow-hidden group border border-[#B9BCB7]">
                         {/* Fill */}
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
                            className="absolute inset-0 opacity-0 cursor-pointer"
                            style={{ appearance: 'slider-vertical' as any }} 
                        />
                    </div>
                    <span className="text-[8px] uppercase">{band}</span>
                </div>
             ))}
        </div>

        <div className="w-px h-16 bg-[#B9BCB7]/50"></div>

        {/* SECTION 4: LOAD & FREQ */}
        <div className="flex flex-col items-center justify-center gap-4 px-4">
             <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-6 py-2 bg-[#F2F2F0] border border-[#B9BCB7] rounded-lg hover:bg-white transition-all text-[10px] uppercase font-bold shadow-sm"
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

             <div className="w-32">
                <div className="flex justify-between text-[8px] mb-1 opacity-70">
                    <span>FREQ</span>
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
    </div>
  );
};