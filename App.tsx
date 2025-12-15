import React, { useState, useEffect, useRef } from 'react';
import { Knob } from './components/Knob';
import { Mixer } from './components/Mixer';
import { Visualizer, VisualizerHandle } from './components/Visualizer';
import { AudioSettings, PhysicsSettings } from './types';
import { audioService } from './services/audioEngine';
import iciLogo from './ici.png';
import { 
  Waves, 
  Activity, 
  MoveDown, 
  Sprout, 
  Merge, 
  Wind, 
  RotateCcw, 
  AudioLines, 
  Disc,
  Radar,
  GalleryHorizontalEnd,
  Droplets,
  Magnet,
  Music,
  Scissors,
  Snowflake
} from 'lucide-react';

const VERSION = "v1.2.1";

const App: React.FC = () => {
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const visualizerRef = useRef<VisualizerHandle>(null);

  // Audio State
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    volume: 0.7,
    low: 0,
    mid: 0,
    high: 0,
    reverbWet: 0.3,
    baseFrequency: 440,
    pingPongWet: 0.0
  });

  // Physics State (0-1 Normalized for knobs)
  const [physicsKnobs, setPhysicsKnobs] = useState({
    reverb: 0.3,
    tempo: 0.5,
    gravity: 0.0,
    budding: 0.0,
    cannibalism: 0.0,
    wind: 0.0,
    reverse: 0.0,
    tuning: 0.5,
    blackHole: 0.0,
    doppler: 0.5,
    pingPong: 0.0,
    weakness: 0.0,
    magneto: 0.5,
    toneMatch: 0.5,
    fragmentation: 0.0,
    freeze: 0.0
  });

  // Derived Physics Settings for the Engine
  const physicsSettings: PhysicsSettings = {
    tempo: physicsKnobs.tempo * 2 + 0.1, // 0.1 to 2.1
    gravity: physicsKnobs.gravity,
    buddingChance: physicsKnobs.budding, // 0 to 1
    cannibalism: physicsKnobs.cannibalism,
    wind: physicsKnobs.wind,
    reverseChance: physicsKnobs.reverse,
    blackHole: physicsKnobs.blackHole,
    doppler: physicsKnobs.doppler,
    pingPong: physicsKnobs.pingPong,
    weakness: physicsKnobs.weakness,
    magneto: physicsKnobs.magneto,
    toneMatch: physicsKnobs.toneMatch,
    fragmentation: physicsKnobs.fragmentation,
    freeze: physicsKnobs.freeze
  };

  useEffect(() => {
    // Sync Audio Params
    const minFreq = 110;
    const maxFreq = 880;
    const newFreq = minFreq + (physicsKnobs.tuning * (maxFreq - minFreq));

    setAudioSettings(prev => ({
      ...prev,
      reverbWet: physicsKnobs.reverb,
      baseFrequency: newFreq,
      pingPongWet: physicsKnobs.pingPong
    }));

    audioService.updateSettings({
      ...audioSettings,
      reverbWet: physicsKnobs.reverb,
      baseFrequency: newFreq,
      pingPongWet: physicsKnobs.pingPong
    });
  }, [physicsKnobs.reverb, physicsKnobs.pingPong, physicsKnobs.tuning, audioSettings.volume, audioSettings.low, audioSettings.mid, audioSettings.high]);

  const handleStart = () => {
    if (!hasInteracted) {
      setHasInteracted(true);
      audioService.init();
    }
    setIsPlaying(!isPlaying);
    if (!isPlaying) audioService.resume();
    else audioService.suspend();
  };

  const handleStop = () => {
    // RESET Logic
    setIsPlaying(false);
    audioService.suspend();
    if (visualizerRef.current) {
      visualizerRef.current.reset();
    }
  };

  const KnobWithIcon = ({ value, onChange, icon: Icon, label, defaultValue = 0.0 }: any) => (
    <div className="flex flex-col items-center gap-2 group relative w-20" title={label}>
      <Knob 
        value={value} 
        onChange={onChange} 
        min={0}
        max={1}
        step={0.01}
        defaultValue={defaultValue}
        size={46}
        color="#7A8476"
        format={(v) => v.toFixed(2)}
      />
      <div className="text-[#5F665F] group-hover:text-[#3F453F] transition-colors flex flex-col items-center gap-1 mt-1">
        <Icon size={16} strokeWidth={1.5} />
      </div>
    </div>
  );

  const GroupLabel = ({text}: {text: string}) => (
      <div className="absolute -top-3 left-4 bg-[#F2F2F0] px-2 text-[9px] text-[#7A8476] tracking-widest uppercase border border-[#B9BCB7] rounded-full">
          {text}
      </div>
  );

  return (
    // Main BG: C1 Snow White
    <div className="min-h-screen bg-[#F2F2F0] text-[#2E2F2B] p-4 md:p-8 flex flex-col items-center pb-20 font-sans selection:bg-[#7A8476] selection:text-white">
      
      <header className="mb-8 text-center">
        {/* Title: C5 Dark Spruce */}
        <h1 className="text-3xl md:text-5xl font-light tracking-[0.2em] text-[#3F453F] lowercase">
          icicles chamber
        </h1>
        {/* Subtitle: C4 Pine Shadow */}
        <p className="text-[#5F665F] text-xs tracking-widest mt-2 uppercase">Generative Frost Synthesis</p>
      </header>

      <div className="w-full max-w-5xl relative flex-1 flex flex-col">
        {/* Visualizer Box */}
        <div className="relative z-10 p-2 rounded-xl bg-[#D9DBD6] shadow-md mb-12">
           <Visualizer 
              ref={visualizerRef}
              isPlaying={isPlaying} 
              physics={physicsSettings}
              audioSettings={audioSettings}
           />
        </div>

        {/* KNOBS SECTION - Grouped */}
        <div className="flex flex-col lg:flex-row justify-center gap-6 mb-12">
            
            {/* GROUP 1: CONTROL (Physics) */}
            <div className="relative flex flex-wrap justify-center gap-4 px-6 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm">
                <GroupLabel text="Physics" />
                <KnobWithIcon value={physicsKnobs.tempo} onChange={(v: number) => setPhysicsKnobs(p => ({...p, tempo: v}))} icon={Activity} label="Tempo" defaultValue={0.5} />
                <KnobWithIcon value={physicsKnobs.gravity} onChange={(v: number) => setPhysicsKnobs(p => ({...p, gravity: v}))} icon={MoveDown} label="Gravity" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.wind} onChange={(v: number) => setPhysicsKnobs(p => ({...p, wind: v}))} icon={Wind} label="Wind" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.freeze} onChange={(v: number) => setPhysicsKnobs(p => ({...p, freeze: v}))} icon={Snowflake} label="Freeze" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.reverse} onChange={(v: number) => setPhysicsKnobs(p => ({...p, reverse: v}))} icon={RotateCcw} label="Reverse" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.weakness} onChange={(v: number) => setPhysicsKnobs(p => ({...p, weakness: v}))} icon={Droplets} label="Weakness" defaultValue={0.0} />
            </div>

            {/* GROUP 2: CREATIVE (Audio + Magneto) */}
            <div className="relative flex flex-wrap justify-center gap-4 px-6 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm">
                <GroupLabel text="Creative" />
                <KnobWithIcon value={physicsKnobs.tuning} onChange={(v: number) => setPhysicsKnobs(p => ({...p, tuning: v}))} icon={AudioLines} label="Tuning" defaultValue={0.5} />
                <KnobWithIcon value={physicsKnobs.reverb} onChange={(v: number) => setPhysicsKnobs(p => ({...p, reverb: v}))} icon={Waves} label="Reverb" defaultValue={0.3} />
                <KnobWithIcon value={physicsKnobs.pingPong} onChange={(v: number) => setPhysicsKnobs(p => ({...p, pingPong: v}))} icon={GalleryHorizontalEnd} label="Delay" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.doppler} onChange={(v: number) => setPhysicsKnobs(p => ({...p, doppler: v}))} icon={Radar} label="Doppler" defaultValue={0.5} />
                <KnobWithIcon value={physicsKnobs.magneto} onChange={(v: number) => setPhysicsKnobs(p => ({...p, magneto: v}))} icon={Magnet} label="Magneto" defaultValue={0.5} />
                <KnobWithIcon value={physicsKnobs.toneMatch} onChange={(v: number) => setPhysicsKnobs(p => ({...p, toneMatch: v}))} icon={Music} label="Tone" defaultValue={0.5} />
            </div>

            {/* GROUP 3: DESTRUCTIVE (Chaos) */}
            <div className="relative flex flex-wrap justify-center gap-4 px-6 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm">
                <GroupLabel text="Destructive" />
                <KnobWithIcon value={physicsKnobs.budding} onChange={(v: number) => setPhysicsKnobs(p => ({...p, budding: v}))} icon={Sprout} label="Budding" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.cannibalism} onChange={(v: number) => setPhysicsKnobs(p => ({...p, cannibalism: v}))} icon={Merge} label="Merge" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.blackHole} onChange={(v: number) => setPhysicsKnobs(p => ({...p, blackHole: v}))} icon={Disc} label="Void" defaultValue={0.0} />
                <KnobWithIcon value={physicsKnobs.fragmentation} onChange={(v: number) => setPhysicsKnobs(p => ({...p, fragmentation: v}))} icon={Scissors} label="Shred" defaultValue={0.0} />
            </div>

        </div>

        {/* Mixer Panel */}
        <Mixer 
          settings={audioSettings} 
          setSettings={setAudioSettings} 
          isPlaying={isPlaying}
          onPlayPause={handleStart}
          onStop={handleStop}
        />

        {!hasInteracted && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#F2F2F0] animate-in fade-in duration-700">
             
             {/* Logo Container */}
             <div className="relative w-64 h-64 md:w-80 md:h-80 mb-12">
                <img 
                    src={iciLogo}
                    alt="Icicles Chamber" 
                    className="w-full h-full object-contain drop-shadow-2xl"
                />
             </div>

             <button 
                onClick={handleStart}
                className="px-10 py-4 bg-[#2E2F2B] text-[#F2F2F0] font-light text-xl tracking-[0.3em] uppercase rounded-sm hover:bg-[#3F453F] hover:scale-[1.02] active:scale-[0.98] transition-all shadow-xl border border-[#5F665F]"
             >
                Enter Chamber
             </button>
             
             <p className="absolute bottom-8 text-[10px] text-[#7A8476] tracking-widest uppercase">
                A Generative Audio Experience
             </p>
          </div>
        )}

        <footer className="w-full text-center text-[10px] text-[#7A8476] opacity-60 font-mono tracking-widest uppercase mt-auto py-8">
             Studio Popłoch (c) 2025 | Pan Grzyb | ptr@o2.pl | {VERSION}
        </footer>
      </div>
    </div>
  );
};

export default App;
