import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Knob } from './components/Knob';
import { Mixer } from './components/Mixer';
import { Visualizer, VisualizerHandle } from './components/Visualizer';
import { AudioSettings, PhysicsSettings, MusicSettings } from './types';
import { audioService } from './services/audioEngine';
import iciLogo from './ici.png';
import { SCALES, DEFAULT_SCALE_ID } from './src/music/scales';
import { NOTE_NAMES, pitchClassToNoteName } from './src/music/notes';
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
  Snowflake,
  Orbit,
  Fish,
} from 'lucide-react';
import { BufferedKnob } from './components/BufferedKnob';

const VERSION = 'v1.2.2';
const SCALE_COUNT = SCALES.length;
const DEFAULT_SCALE_INDEX = Math.max(0, SCALES.findIndex((scale) => scale.id === DEFAULT_SCALE_ID));
const SCALE_STEP = SCALE_COUNT > 1 ? 1 / (SCALE_COUNT - 1) : 1;
const DEFAULT_SCALE_VALUE = SCALE_COUNT > 1 ? DEFAULT_SCALE_INDEX / (SCALE_COUNT - 1) : 0;

const clampScaleIndex = (index: number) => Math.max(0, Math.min(SCALE_COUNT - 1, index));
const scaleValueFromIndex = (index: number) => (SCALE_COUNT > 1 ? index / (SCALE_COUNT - 1) : 0);
const scaleIndexFromValue = (value: number) => clampScaleIndex(Math.round(value * (SCALE_COUNT - 1)));

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number }>;

type KnobWithIconProps = {
  value: number;
  onChange: (v: number) => void;
  icon: IconType;
  label: string;
  defaultValue?: number;
  step?: number;
  onIconClick?: () => void;
  children?: React.ReactNode;
};

const KnobWithIcon: React.FC<KnobWithIconProps> = ({
  value,
  onChange,
  icon: Icon,
  label,
  defaultValue = 0.0,
  step = 0.01,
  onIconClick,
  children,
}) => (
  <div className="flex flex-col items-center gap-2 group relative w-20" title={label}>
    <BufferedKnob
      value={value}
      onCommit={onChange}
      min={0}
      max={1}
      steps={step ? Math.round(1 / step) + 1 : undefined}
      defaultValue={defaultValue}
      size={46}
      color="#7A8476"
      format={(v) => v.toFixed(2)}
    />
    {onIconClick ? (
      <button
        type="button"
        onClick={onIconClick}
        onPointerDown={(e) => e.stopPropagation()}
        className="text-[#5F665F] group-hover:text-[#3F453F] transition-colors flex flex-col items-center gap-1 mt-1"
        aria-label={label}
      >
        <Icon size={16} strokeWidth={1.5} />
      </button>
    ) : (
      <div className="text-[#5F665F] group-hover:text-[#3F453F] transition-colors flex flex-col items-center gap-1 mt-1">
        <Icon size={16} strokeWidth={1.5} />
      </div>
    )}
    {children}
  </div>
);

const GroupLabel: React.FC<{ text: string }> = ({ text }) => (
  <div className="absolute -top-3 left-4 bg-[#F2F2F0] px-2 text-[9px] text-[#7A8476] tracking-widest uppercase border border-[#B9BCB7] rounded-full">
    {text}
  </div>
);

const App: React.FC = () => {
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState(false);
  const visualizerRef = useRef<VisualizerHandle>(null);

  // Mixer-controlled audio params only (avoid rewriting these on every knob tick)
  const [mixerSettings, setMixerSettings] = useState<AudioSettings>({
    volume: 0.7,
    low: 0,
    mid: 0,
    high: 0,
    reverbWet: 0.3,
    baseFrequency: 440,
    pingPongWet: 0.0,
    compThreshold: -12,
    compRatio: 3,
    compAttack: 0.005,   // 5ms
    compRelease: 0.5,    // 500ms
    makeupGainDb: 8,
    limiterThreshold: -1,
  });

  // Physics knobs (0..1)
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
    doppler: 0.0,
    pingPong: 0.0,
    weakness: 0.0,
    magneto: 0.5,
    fragmentation: 0.0,
    freeze: 0.0,
    geometryWarp: 0.0,
    roomWave: 0.0,
  });

  const [musicSettings, setMusicSettings] = useState<MusicSettings>({
    root: 0,
    scaleId: SCALES[DEFAULT_SCALE_INDEX]?.id ?? DEFAULT_SCALE_ID,
    scaleIndex: DEFAULT_SCALE_VALUE,
    quantizeEnabled: true,
    noImmediateRepeat: true,
    avoidLeadingTone: false,
    noThirds: false,
  });

  const [isMusicOpen, setIsMusicOpen] = useState(false);
  const musicPanelRef = useRef<HTMLDivElement>(null);

  // Derived physics for engine (memoized to avoid object churn each render)
  const physicsSettings: PhysicsSettings = useMemo(
    () => ({
      tempo: physicsKnobs.tempo * 2 + 0.1,
      gravity: physicsKnobs.gravity,
      buddingChance: physicsKnobs.budding,
      cannibalism: physicsKnobs.cannibalism,
      wind: physicsKnobs.wind,
      reverseChance: physicsKnobs.reverse,
      blackHole: physicsKnobs.blackHole,
      doppler: physicsKnobs.doppler,
      pingPong: physicsKnobs.pingPong,
      weakness: physicsKnobs.weakness,
      magneto: physicsKnobs.magneto,
      fragmentation: physicsKnobs.fragmentation,
      freeze: physicsKnobs.freeze,
      geometryWarp: physicsKnobs.geometryWarp,
      roomWave: physicsKnobs.roomWave,
    }),
    [physicsKnobs]
  );

  // Derived audio params from knobs
  const derivedAudio = useMemo(() => {
    const minFreq = 110;
    const maxFreq = 880;
    const baseFrequency = minFreq + physicsKnobs.tuning * (maxFreq - minFreq);

    return {
      reverbWet: physicsKnobs.reverb,
      pingPongWet: physicsKnobs.pingPong,
      baseFrequency,
    };
  }, [physicsKnobs.reverb, physicsKnobs.pingPong, physicsKnobs.tuning]);

  // Engine audio settings = mixer + derived (single source of truth for engine)
  const engineAudioSettings: AudioSettings = useMemo(
    () => ({
      ...mixerSettings,
      reverbWet: derivedAudio.reverbWet,
      pingPongWet: derivedAudio.pingPongWet,
      baseFrequency: derivedAudio.baseFrequency,
    }),
    [
      mixerSettings,
      derivedAudio.reverbWet,
      derivedAudio.pingPongWet,
      derivedAudio.baseFrequency,
    ]
  );

  // Throttle engine updates to 1x per frame (mobile smoothness)
  const rafRef = useRef<number | null>(null);
  const latestEngineSettingsRef = useRef<AudioSettings>(engineAudioSettings);

  useEffect(() => {
    latestEngineSettingsRef.current = engineAudioSettings;

    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      audioService.updateSettings(latestEngineSettingsRef.current);
    });
  }, [engineAudioSettings]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isMusicOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!musicPanelRef.current) return;
      if (!musicPanelRef.current.contains(e.target as Node)) {
        setIsMusicOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isMusicOpen]);

  useEffect(() => {
    audioService.updateMusicSettings(musicSettings);
  }, [musicSettings]);

  const handleStart = useCallback(async () => {
    await audioService.primeFromGesture();

    const next = !isPlaying;
    setIsPlaying(next);

    if (!hasInteracted) {
      setHasInteracted(true);
      await audioService.init();
    }

    if (next) await audioService.resume();
    else await audioService.suspend();

    const state = audioService.getContextState();
    setAudioNeedsUnlock(next && state !== 'running');
  }, [hasInteracted, isPlaying]);

  const handleStop = useCallback(async () => {
    setIsPlaying(false);
    setAudioNeedsUnlock(false);
    await audioService.suspend();
    visualizerRef.current?.reset();
  }, []);

  const handleUnlockAudio = useCallback(async () => {
    await audioService.primeFromGesture();
    if (!hasInteracted) setHasInteracted(true);
    const state = audioService.getContextState();
    setAudioNeedsUnlock(state !== 'running');
  }, [hasInteracted]);

  const selectedScale = useMemo(
    () => SCALES.find((scale) => scale.id === musicSettings.scaleId) ?? SCALES[DEFAULT_SCALE_INDEX],
    [musicSettings.scaleId]
  );

  const scalePreview = useMemo(() => {
    const rootName = pitchClassToNoteName(musicSettings.root);
    const intervals = selectedScale.intervals.join(' ');
    const notes = selectedScale.intervals.map((i) => pitchClassToNoteName(musicSettings.root + i)).join(' ');
    return `Scale: ${rootName} ${selectedScale.label} | intervals: ${intervals} | notes: ${notes}`;
  }, [musicSettings.root, selectedScale]);

  const setScaleByIndex = useCallback((index: number) => {
    const clamped = clampScaleIndex(index);
    const scale = SCALES[clamped] ?? SCALES[DEFAULT_SCALE_INDEX];
    setMusicSettings((prev) => ({
      ...prev,
      scaleId: scale?.id ?? DEFAULT_SCALE_ID,
      scaleIndex: scaleValueFromIndex(clamped),
    }));
  }, []);

  const setScaleById = useCallback((scaleId: string) => {
    const index = SCALES.findIndex((scale) => scale.id === scaleId);
    setScaleByIndex(index >= 0 ? index : DEFAULT_SCALE_INDEX);
  }, [setScaleByIndex]);

  const handleMusicKnobChange = useCallback((value: number) => {
    setScaleByIndex(scaleIndexFromValue(value));
  }, [setScaleByIndex]);

  const toggleMusicPanel = useCallback(() => {
    setIsMusicOpen((prev) => !prev);
  }, []);

  // helpers: reduce inline noise
  const setKnob = useCallback(<K extends keyof typeof physicsKnobs>(key: K, v: number) => {
    setPhysicsKnobs((p) => ({ ...p, [key]: v }));
  }, [physicsKnobs]);

  return (
    <div className="min-h-screen bg-[#F2F2F0] text-[#2E2F2B] p-2 md:p-8 flex flex-col items-center pb-20 font-sans selection:bg-[#7A8476] selection:text-white">
      <header className="mb-8 text-center mt-4 md:mt-0">
        <h1 className="text-3xl md:text-5xl font-light tracking-[0.2em] text-[#3F453F] lowercase">icicles chamber</h1>
        <p className="text-[#5F665F] text-xs tracking-widest mt-2 uppercase">Generative Frost Synthesis</p>
      </header>

      {audioNeedsUnlock && (
        <div className="mb-4 flex justify-center w-full">
          <button
            onPointerDown={handleUnlockAudio}
            onClick={handleUnlockAudio}
            className="px-4 py-2 bg-[#2E2F2B] text-[#F2F2F0] text-[10px] uppercase tracking-[0.2em] rounded-sm border border-[#5F665F] shadow-sm hover:bg-[#3F453F]"
          >
            Tap to enable audio
          </button>
        </div>
      )}

      <div className="w-full max-w-5xl relative flex-1 flex flex-col">
        <div className="relative z-10 p-2 rounded-xl bg-[#D9DBD6] shadow-md mb-8 md:mb-12 sticky top-2 md:static">
          <Visualizer
            ref={visualizerRef}
            isPlaying={isPlaying}
            physics={physicsSettings}
            audioSettings={engineAudioSettings}
            musicSettings={musicSettings}
          />
        </div>

        <div className="flex flex-col xl:flex-row justify-center gap-6 mb-12">
          <div className="relative flex flex-wrap justify-center gap-4 px-4 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm w-full xl:w-auto">
            <GroupLabel text="Physics" />
            <KnobWithIcon value={physicsKnobs.tempo} onChange={(v) => setKnob('tempo', v)} icon={Activity} label="Tempo" defaultValue={0.5} />
            <KnobWithIcon value={physicsKnobs.gravity} onChange={(v) => setKnob('gravity', v)} icon={MoveDown} label="Gravity" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.wind} onChange={(v) => setKnob('wind', v)} icon={Wind} label="Wind" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.freeze} onChange={(v) => setKnob('freeze', v)} icon={Snowflake} label="Freeze" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.reverse} onChange={(v) => setKnob('reverse', v)} icon={RotateCcw} label="Reverse" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.weakness} onChange={(v) => setKnob('weakness', v)} icon={Droplets} label="Weakness" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.geometryWarp} onChange={(v) => setKnob('geometryWarp', v)} icon={Orbit} label="Geometry" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.roomWave} onChange={(v) => setKnob('roomWave', v)} icon={Fish} label="Wave" defaultValue={0.0} />
          </div>

          <div className="relative flex flex-wrap justify-center gap-4 px-4 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm w-full xl:w-auto">
            <GroupLabel text="Creative" />
            <KnobWithIcon value={physicsKnobs.tuning} onChange={(v) => setKnob('tuning', v)} icon={AudioLines} label="Tuning" defaultValue={0.5} />
            <KnobWithIcon value={physicsKnobs.reverb} onChange={(v) => setKnob('reverb', v)} icon={Waves} label="Reverb" defaultValue={0.3} />
            <KnobWithIcon value={physicsKnobs.pingPong} onChange={(v) => setKnob('pingPong', v)} icon={GalleryHorizontalEnd} label="Delay" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.doppler} onChange={(v) => setKnob('doppler', v)} icon={Radar} label="Doppler" defaultValue={0.5} />
            <KnobWithIcon value={physicsKnobs.magneto} onChange={(v) => setKnob('magneto', v)} icon={Magnet} label="Magneto" defaultValue={0.5} />
            <KnobWithIcon
              value={musicSettings.scaleIndex}
              onChange={handleMusicKnobChange}
              icon={Music}
              label="Music"
              defaultValue={DEFAULT_SCALE_VALUE}
              step={SCALE_STEP}
              onIconClick={toggleMusicPanel}
            >
              {isMusicOpen && (
                <div
                  ref={musicPanelRef}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute left-1/2 top-full mt-3 w-64 -translate-x-1/2 rounded-xl border border-[#B9BCB7] bg-[#F2F2F0] p-3 shadow-xl z-30 text-[#2E2F2B]"
                >
                  <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-[#7A8476]">
                    <span>Root</span>
                    <select
                      value={musicSettings.root}
                      onChange={(e) => setMusicSettings((prev) => ({ ...prev, root: parseInt(e.target.value, 10) }))}
                      className="bg-[#E7E8E5] border border-[#B9BCB7] text-[10px] px-2 py-1 rounded-sm"
                    >
                      {NOTE_NAMES.map((note, index) => (
                        <option key={note} value={index}>
                          {note}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-3">
                    <div className="text-[9px] uppercase tracking-widest text-[#7A8476] mb-1">Scale</div>
                    <div className="max-h-32 overflow-y-auto rounded-md border border-[#B9BCB7] bg-[#E7E8E5]">
                      {SCALES.map((scale) => {
                        const isActive = scale.id === musicSettings.scaleId;
                        const tagText = scale.tags?.slice(0, 3).join(' ');
                        return (
                          <button
                            key={scale.id}
                            type="button"
                            onClick={() => {
                              setScaleById(scale.id);
                              setIsMusicOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2 py-1 text-left text-[10px] border-b border-[#D9DBD6] last:border-b-0 ${
                              isActive ? 'bg-[#D9DBD6] text-[#2E2F2B]' : 'hover:bg-[#D9DBD6] text-[#5F665F]'
                            }`}
                          >
                            <span>{scale.label}</span>
                            {tagText && (
                              <span className="text-[8px] uppercase tracking-wider text-[#7A8476]">{tagText}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-[9px] uppercase tracking-widest text-[#5F665F]">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={musicSettings.avoidLeadingTone}
                        onChange={(e) => setMusicSettings((prev) => ({ ...prev, avoidLeadingTone: e.target.checked }))}
                        className="accent-[#7A8476]"
                      />
                      Avoid Leading Tone
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={musicSettings.noImmediateRepeat}
                        onChange={(e) => setMusicSettings((prev) => ({ ...prev, noImmediateRepeat: e.target.checked }))}
                        className="accent-[#7A8476]"
                      />
                      No Immediate Repeat
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={musicSettings.noThirds}
                        onChange={(e) => setMusicSettings((prev) => ({ ...prev, noThirds: e.target.checked }))}
                        className="accent-[#7A8476]"
                      />
                      No 3rd Filter
                    </label>
                  </div>

                  <div className="mt-3 text-[9px] font-mono text-[#5F665F] leading-snug">
                    {scalePreview}
                  </div>
                </div>
              )}
            </KnobWithIcon>
          </div>

          <div className="relative flex flex-wrap justify-center gap-4 px-4 py-8 bg-[#F2F2F0] rounded-3xl border border-[#B9BCB7] shadow-sm w-full xl:w-auto">
            <GroupLabel text="Destructive" />
            <KnobWithIcon value={physicsKnobs.budding} onChange={(v) => setKnob('budding', v)} icon={Sprout} label="Budding" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.cannibalism} onChange={(v) => setKnob('cannibalism', v)} icon={Merge} label="Merge" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.blackHole} onChange={(v) => setKnob('blackHole', v)} icon={Disc} label="Void" defaultValue={0.0} />
            <KnobWithIcon value={physicsKnobs.fragmentation} onChange={(v) => setKnob('fragmentation', v)} icon={Scissors} label="Shred" defaultValue={0.0} />
          </div>
        </div>

        <Mixer
          settings={engineAudioSettings}
          setSettings={setMixerSettings}
          isPlaying={isPlaying}
          onPlayPause={handleStart}
          onStop={handleStop}
        />

        {!hasInteracted && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#F2F2F0] animate-in fade-in duration-700">
            <div className="relative w-64 h-64 md:w-80 md:h-80 mb-12">
              <img src={iciLogo} alt="Icicles Chamber" className="w-full h-full object-contain drop-shadow-2xl" />
            </div>

            <button
              onPointerDown={handleStart}
              onClick={handleStart}
              className="px-10 py-4 bg-[#2E2F2B] text-[#F2F2F0] font-light text-xl tracking-[0.3em] uppercase rounded-sm hover:bg-[#3F453F] hover:scale-[1.02] active:scale-[0.98] transition-all shadow-xl border border-[#5F665F]"
            >
              Enter Chamber
            </button>

            <p className="absolute bottom-8 text-[10px] text-[#7A8476] tracking-widest uppercase">A Generative Audio Experience</p>
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
