import { AudioSettings, MusicSettings, SoundType } from '../types';
import { getScaleById } from '../src/music/scales';
import type { ScaleDef } from '../src/music/scales';
import { freqToMidi, midiToFreq, snapMidiToPitchClass } from '../src/music/notes';
import { quantizeMidiToScale } from '../src/music/quantize';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const WET_BOOST = 5;
const applyWetBoost = (raw: number) => {
  const v = clamp(raw, 0, 1);
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return (v * WET_BOOST) / (1 + (WET_BOOST - 1) * v);
};

type SourceChoice = { type: 'mic' | 'smp' | 'synth'; index?: number };

const GRANULAR_WORKLET_CODE = `
class GranularStretchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'stretch', defaultValue: 1.0, minValue: 0.5, maxValue: 2.5 },
      { name: 'mix', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'grainSize', defaultValue: 0.08, minValue: 0.02, maxValue: 0.2 },
    ];
  }
  constructor() {
    super();
    this.bufferSize = Math.floor(sampleRate * 1.2);
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.grains = [];
    this.grainClock = 0;
    this.lastGrainSize = Math.max(16, Math.floor(sampleRate * 0.08));
  }
  _spawnGrain(stretch, grainSamples) {
    const delaySamples = Math.max(grainSamples + 32, Math.floor(sampleRate * 0.05));
    let start = this.writeIndex - delaySamples;
    if (start < 0) start += this.bufferSize;
    if (this.grains.length >= 4) this.grains.shift();
    this.grains.push({
      pos: start,
      age: 0,
      len: grainSamples,
      rate: 1 / Math.max(0.5, Math.min(2.5, stretch)),
    });
  }
  _readSample(pos) {
    const i0 = Math.floor(pos);
    const i1 = (i0 + 1) % this.bufferSize;
    const t = pos - i0;
    const a = this.buffer[i0] || 0;
    const b = this.buffer[i1] || 0;
    return a + (b - a) * t;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const inCh = input && input[0] ? input[0] : null;
    const outCh = output[0];
    const stretchArr = parameters.stretch;
    const mixArr = parameters.mix;
    const grainArr = parameters.grainSize;

    for (let i = 0; i < outCh.length; i++) {
      const x = inCh ? inCh[i] : 0;
      this.buffer[this.writeIndex] = x;

      const stretch = stretchArr.length > 1 ? stretchArr[i] : stretchArr[0];
      const mix = mixArr.length > 1 ? mixArr[i] : mixArr[0];
      const grainSec = grainArr.length > 1 ? grainArr[i] : grainArr[0];
      const grainSamples = Math.max(16, Math.floor(sampleRate * grainSec));
      if (grainSamples !== this.lastGrainSize) this.lastGrainSize = grainSamples;

      this.grainClock++;
      const spacing = Math.max(8, Math.floor(this.lastGrainSize * 0.5));
      if (this.grainClock >= spacing || this.grains.length === 0) {
        this.grainClock = 0;
        this._spawnGrain(stretch, this.lastGrainSize);
      }

      let wet = 0;
      let norm = 0;
      let alive = 0;
      for (let g = 0; g < this.grains.length; g++) {
        const grain = this.grains[g];
        if (grain.age >= grain.len) continue;
        const t = grain.age / grain.len;
        const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
        wet += this._readSample(grain.pos) * win;
        norm += win;
        grain.pos += grain.rate;
        if (grain.pos >= this.bufferSize) grain.pos -= this.bufferSize;
        grain.age++;
        this.grains[alive++] = grain;
      }
      this.grains.length = alive;

      const wetOut = norm > 0 ? wet / norm : 0;
      const m = Math.max(0, Math.min(1, mix));
      outCh[i] = x * (1 - m) + wetOut * m;

      this.writeIndex++;
      if (this.writeIndex >= this.bufferSize) this.writeIndex = 0;
    }
    return true;
  }
}
registerProcessor('granular-stretch', GranularStretchProcessor);
`;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private makeupGain: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private mainAnalyser: AnalyserNode | null = null;
  private peakAnalyser: AnalyserNode | null = null;
  private stereoSplitter: ChannelSplitterNode | null = null;
  private stereoAnalyserL: AnalyserNode | null = null;
  private stereoAnalyserR: AnalyserNode | null = null;
  private stereoBufferL: Float32Array | null = null;
  private stereoBufferR: Float32Array | null = null;
  private lastDelayTimes: { left: number; right: number } | null = null;
  private micGain: GainNode | null = null;
  private micComp: DynamicsCompressorNode | null = null;
  private micLimiter: DynamicsCompressorNode | null = null;
  private micMeter: AnalyserNode | null = null;
  private micRecordDest: MediaStreamAudioDestinationNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micEnsureInFlight: Promise<void> | null = null;
  private desiredMicGain: number = 2.6;
  private desiredMasterGain: number = 0.7;
  private lastAudioSettings: AudioSettings | null = null;
  
  private reverbNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private dryGain: GainNode | null = null;

  // Ping Pong Delay Nodes
  private pingPongInput: GainNode | null = null;
  private delayL: DelayNode | null = null;
  private delayR: DelayNode | null = null;
  private feedbackL: GainNode | null = null;
  private feedbackR: GainNode | null = null;
  private pingPongMerger: ChannelMergerNode | null = null;
  private pingPongReturn: GainNode | null = null;
  private granularNode: AudioWorkletNode | null = null;
  private granularGain: GainNode | null = null;
  private spatialControl = { pan: 0, depth: 0, width: 0 };
  
  // EQ Nodes
  private lowEQ: BiquadFilterNode | null = null;
  private midEQ: BiquadFilterNode | null = null;
  private highEQ: BiquadFilterNode | null = null;

  private customBuffer: AudioBuffer | null = null;
  private soundType: SoundType = SoundType.SYNTH;

  // Sample banks
  private micBank: (AudioBuffer | null)[] = new Array(6).fill(null);
  private sampleBank: (AudioBuffer | null)[] = new Array(6).fill(null);
  private micInsertIndex = 0;
  private synthEnabled = true;
  private playPool: SourceChoice[] = [];
  private playCursor = 0;

  // Polyphony Management
  private activeVoices: number = 0;
  private readonly MAX_VOICES: number = 40; 

  private lastMidi: number | null = null;
  private dronePool: number[] | null = null;
  private droneScaleId: string | null = null;
  private droneTriggerCount: number = 0;
  private didInstallLifecycle: boolean = false;
  private didInstallGestureUnlock: boolean = false;
  private lastUserGestureAt: number = 0;
  private shouldPlay: boolean = false;
  private lastMusicSettings: MusicSettings | null = null;
  private backgroundDrone: {
    oscillators: OscillatorNode[];
    gains: GainNode[];
    masterGain: GainNode;
    filter: BiquadFilterNode;
    lfo?: OscillatorNode;
    lfoGain?: GainNode;
  } | null = null;

  public async init(): Promise<void> {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
      latencyHint: 'interactive',
    });
    
    // Analysers
    this.mainAnalyser = this.ctx.createAnalyser();
    this.mainAnalyser.fftSize = 256;
    this.mainAnalyser.smoothingTimeConstant = 0.6;
    this.peakAnalyser = this.ctx.createAnalyser();
    this.peakAnalyser.fftSize = 256;
    this.peakAnalyser.smoothingTimeConstant = 0.6;
    this.stereoSplitter = this.ctx.createChannelSplitter(2);
    this.stereoAnalyserL = this.ctx.createAnalyser();
    this.stereoAnalyserL.fftSize = 256;
    this.stereoAnalyserL.smoothingTimeConstant = 0.7;
    this.stereoAnalyserR = this.ctx.createAnalyser();
    this.stereoAnalyserR.fftSize = 256;
    this.stereoAnalyserR.smoothingTimeConstant = 0.7;
    this.micMeter = this.ctx.createAnalyser();
    this.micMeter.fftSize = 1024;
    this.micMeter.smoothingTimeConstant = 0.65;

    // Compressor (musical)
    this.compressorNode = this.ctx.createDynamicsCompressor();
    this.compressorNode.ratio.value = 3;
    this.compressorNode.attack.value = 0.0001; // 0.10ms
    this.compressorNode.release.value = 0.5;   // 500ms
    this.compressorNode.knee.value = 6;

    // Make-up gain
    this.makeupGain = this.ctx.createGain();
    this.makeupGain.gain.value = 1;

    // LIMITER (True peak safety)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1.0;
    this.limiterNode.knee.value = 10;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0.002;
    this.limiterNode.release.value = 0.2;

    // Master Gain - Boosted significantly
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.desiredMasterGain; 

    // Mic chain (muted to master, for metering only)
    this.micGain = this.ctx.createGain();
    this.micGain.gain.value = this.desiredMicGain;
    this.micComp = this.ctx.createDynamicsCompressor();
    this.micComp.threshold.value = -18;
    this.micComp.ratio.value = 3.5;
    this.micComp.attack.value = 0.003;
    this.micComp.release.value = 0.25;
    this.micComp.knee.value = 6;

    this.micLimiter = this.ctx.createDynamicsCompressor();
    this.micLimiter.threshold.value = -1.5;
    this.micLimiter.knee.value = 8;
    this.micLimiter.ratio.value = 20;
    this.micLimiter.attack.value = 0.002;
    this.micLimiter.release.value = 0.2;

    this.micRecordDest = this.ctx.createMediaStreamDestination();
    const micSilent = this.ctx.createGain();
    micSilent.gain.value = 0;
    if (this.micMeter) {
      this.micGain.connect(this.micComp);
      this.micComp.connect(this.micLimiter);
      this.micLimiter.connect(this.micMeter);
      if (this.micRecordDest) this.micLimiter.connect(this.micRecordDest);
      this.micMeter.connect(micSilent);
      micSilent.connect(this.ctx.destination);
    }

    // EQ
    this.lowEQ = this.ctx.createBiquadFilter();
    this.lowEQ.type = 'lowshelf';
    this.lowEQ.frequency.value = 250;

    this.midEQ = this.ctx.createBiquadFilter();
    this.midEQ.type = 'peaking';
    this.midEQ.frequency.value = 1200;
    this.midEQ.Q.value = 0.5;

    this.highEQ = this.ctx.createBiquadFilter();
    this.highEQ.type = 'highshelf';
    this.highEQ.frequency.value = 4000;

    // Reverb
    this.reverbNode = this.ctx.createConvolver();
    this.createImpulseResponse();
    this.reverbGain = this.ctx.createGain();
    this.dryGain = this.ctx.createGain();

    // --- PING PONG DELAY SETUP ---
    this.pingPongInput = this.ctx.createGain();
    this.pingPongInput.gain.value = 1;
    this.delayL = this.ctx.createDelay();
    this.delayR = this.ctx.createDelay();
    this.feedbackL = this.ctx.createGain();
    this.feedbackR = this.ctx.createGain();
    this.pingPongMerger = this.ctx.createChannelMerger(2);
    this.pingPongReturn = this.ctx.createGain();
    this.pingPongReturn.gain.value = 0;

    this.delayL.delayTime.value = 0.35; 
    this.delayR.delayTime.value = 0.5; 
    this.feedbackL.gain.value = 0.3; 
    this.feedbackR.gain.value = 0.3;

    await this.ensureGranularNode();
    this.pingPongInput.connect(this.delayL);
    if (this.granularNode) {
      this.granularGain = this.ctx.createGain();
      this.granularGain.gain.value = 0.6;
      this.pingPongInput.connect(this.granularNode);
      this.granularNode.connect(this.granularGain);
      this.granularGain.connect(this.delayL);
    }
    this.delayL.connect(this.pingPongMerger, 0, 0);
    this.delayL.connect(this.feedbackL).connect(this.delayR);
    this.delayR.connect(this.pingPongMerger, 0, 1);
    this.delayR.connect(this.feedbackR).connect(this.delayL);

    // --- MAIN ROUTING ---
    this.reverbNode.connect(this.reverbGain);
    
    this.reverbGain.connect(this.lowEQ);
    this.dryGain.connect(this.lowEQ);
    this.pingPongMerger.connect(this.pingPongReturn);
    this.pingPongReturn.connect(this.lowEQ);

    this.lowEQ.connect(this.midEQ);
    this.midEQ.connect(this.highEQ);
    // highEQ -> compressor -> makeup -> limiter -> main analyser -> destination
    this.highEQ.connect(this.compressorNode);
    this.compressorNode.connect(this.makeupGain);
    this.makeupGain.connect(this.limiterNode);
    // tap peak before limiter
    this.makeupGain.connect(this.peakAnalyser);
    this.limiterNode.connect(this.mainAnalyser);
    if (this.stereoSplitter && this.stereoAnalyserL && this.stereoAnalyserR) {
      this.limiterNode.connect(this.stereoSplitter);
      this.stereoSplitter.connect(this.stereoAnalyserL, 0);
      this.stereoSplitter.connect(this.stereoAnalyserR, 1);
    }
    this.mainAnalyser.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.installLifecycle();
    this.installGestureUnlock();

    if (this.lastAudioSettings) this.updateSettings(this.lastAudioSettings);
    try { await this.ctx.resume(); } catch { /* ignore */ }
  }

  private static extractPeakDb(analyser: AnalyserNode | null): number {
    if (!analyser) return -100;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    if (max === 0) return -100;
    return 20 * Math.log10(max);
  }

  private static extractPeakLinear(
    analyser: AnalyserNode | null,
    buffer: Float32Array | null
  ): { level: number; buffer: Float32Array | null } {
    if (!analyser) return { level: 0, buffer };
    const size = analyser.fftSize;
    let data = buffer;
    if (!data || data.length !== size) data = new Float32Array(size);
    analyser.getFloatTimeDomainData(data);
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    return { level: Math.min(1, max), buffer: data };
  }

  public getMainLevel(): number {
    return AudioEngine.extractPeakDb(this.mainAnalyser);
  }

  public getPeakLevel(): number {
    return AudioEngine.extractPeakDb(this.peakAnalyser);
  }

  public getStereoLevels(): { left: number; right: number } {
    const left = AudioEngine.extractPeakLinear(this.stereoAnalyserL, this.stereoBufferL);
    this.stereoBufferL = left.buffer;
    const right = AudioEngine.extractPeakLinear(this.stereoAnalyserR, this.stereoBufferR);
    this.stereoBufferR = right.buffer;
    return { left: left.level, right: right.level };
  }

  public async resume(): Promise<void> {
    if (!this.ctx) await this.init();
    if (!this.ctx) return;

    this.shouldPlay = true;
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }

    await this.iosSilentTick();

    if (document.hidden && this.ctx.state === 'running') {
      this.startBackgroundDrone();
    }
  }

  public async suspend(): Promise<void> {
    if (!this.ctx) return;
    this.shouldPlay = false;
    this.stopBackgroundDrone();
    // Keep the context alive for mic metering if a mic stream is attached.
    if (this.micStream) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      console.error('Mic access API unavailable in this browser.');
      return;
    }
    try { await this.ctx.suspend(); } catch { /* ignore */ }
  }

  public async primeFromGesture(): Promise<void> {
    await this.init();
    await this.resume();
  }

  public updateMusicSettings(settings: MusicSettings) {
    this.lastMusicSettings = settings;
  }

  private installLifecycle() {
    if (this.didInstallLifecycle) return;
    this.didInstallLifecycle = true;

    const tryResume = () => {
      if (!this.ctx || !this.shouldPlay) return;
      void this.resume();
    };

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.stopBackgroundDrone();
        tryResume();
      } else if (this.shouldPlay) {
        this.startBackgroundDrone();
        tryResume();
      }
    });

    window.addEventListener('focus', () => {
      this.stopBackgroundDrone();
      tryResume();
    });
    window.addEventListener('pageshow', () => {
      this.stopBackgroundDrone();
      tryResume();
    });
  }

  private installGestureUnlock() {
    if (this.didInstallGestureUnlock) return;
    this.didInstallGestureUnlock = true;

    const unlock = async () => {
      this.lastUserGestureAt = performance.now();
      await this.resume();
      if (this.ctx && this.ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('touchstart', unlock);
      }
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
  }

  private async ensureGranularNode(): Promise<void> {
    if (!this.ctx || this.granularNode || !this.ctx.audioWorklet) return;
    try {
      const blob = new Blob([GRANULAR_WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.granularNode = new AudioWorkletNode(this.ctx, 'granular-stretch', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    } catch (e) {
      console.warn('Granular worklet unavailable, skipping stretch.', e);
      this.granularNode = null;
    }
  }

  private async iosSilentTick(): Promise<void> {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      osc.start(now);
      osc.stop(now + 0.03);
    } catch { /* ignore */ }
  }

  private startBackgroundDrone() {
    if (!this.ctx || !this.dryGain || !this.reverbNode || this.backgroundDrone) return;

    const music = this.lastMusicSettings ?? {
      root: 0,
      scaleId: getScaleById().id,
      scaleIndex: 0,
      quantizeEnabled: true,
      noImmediateRepeat: false,
      avoidLeadingTone: false,
      noThirds: false,
    };

    const scale = getScaleById(music.scaleId);
    let intervals = scale.intervals.slice();
    if (music.noThirds || scale.tags?.includes('no3rd')) {
      intervals = intervals.filter((i) => i !== 3 && i !== 4);
    }
    if (music.avoidLeadingTone || scale.avoid?.leadingTone) {
      intervals = intervals.filter((i) => i !== 11);
    }
    if (intervals.length === 0) intervals = scale.intervals.length ? scale.intervals : [0];

    const droneIntervals = this.buildDronePool(intervals).slice(0, 3);
    const rootPc = ((music.root % 12) + 12) % 12;
    const baseRootMidi = 48 + rootPc;

    // When running in background, keep the AudioContext alive but stay effectively silent.
    const masterGain = this.ctx.createGain();
    masterGain.gain.value = 0.00001;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.5;

    masterGain.connect(filter);
    filter.connect(this.dryGain);
    filter.connect(this.reverbNode);

    const oscillators: OscillatorNode[] = [];
    const gains: GainNode[] = [];

    droneIntervals.forEach((interval, index) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      const midi = interval === 0 ? baseRootMidi - 12 : baseRootMidi + interval;
      osc.frequency.value = midiToFreq(midi);
      osc.detune.value = (Math.random() - 0.5) * 6;

      const gain = this.ctx!.createGain();
      gain.gain.value = index === 0 ? 0.35 : 0.2;
      osc.connect(gain).connect(masterGain);
      osc.start();

      oscillators.push(osc);
      gains.push(gain);
    });

    this.backgroundDrone = {
      oscillators,
      gains,
      masterGain,
      filter,
    };
  }

  private stopBackgroundDrone() {
    if (!this.backgroundDrone || !this.ctx) return;
    const now = this.ctx.currentTime;
    const { oscillators, gains, masterGain, filter, lfo, lfoGain } = this.backgroundDrone;

    gains.forEach((gain) => gain.gain.setTargetAtTime(0.0001, now, 0.4));
    masterGain.gain.setTargetAtTime(0.0001, now, 0.4);

    oscillators.forEach((osc) => {
      try { osc.stop(now + 1); } catch { /* ignore */ }
    });
    if (lfo) {
      try { lfo.stop(now + 1); } catch { /* ignore */ }
    }

    setTimeout(() => {
      try { lfoGain?.disconnect(); } catch { /* ignore */ }
      try { lfo?.disconnect(); } catch { /* ignore */ }
      try { filter.disconnect(); } catch { /* ignore */ }
      try { masterGain.disconnect(); } catch { /* ignore */ }
      gains.forEach((gain) => { try { gain.disconnect(); } catch { /* ignore */ } });
      oscillators.forEach((osc) => { try { osc.disconnect(); } catch { /* ignore */ } });
    }, 1200);

    this.backgroundDrone = null;
  }

  private createImpulseResponse() {
    if (!this.ctx || !this.reverbNode) return;
    const rate = this.ctx.sampleRate;
    const length = rate * 4.0; 
    const decay = 4.0;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        const n = i / length;
        left[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, decay);
        right[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, decay);
    }
    this.reverbNode.buffer = impulse;
  }

  private buildDronePool(intervals: number[]): number[] {
    const unique = Array.from(new Set(intervals)).sort((a, b) => a - b);
    if (unique.length === 0) return [0];

    const pool: number[] = [];
    if (unique.includes(0)) pool.push(0);
    else pool.push(unique[0]);

    const maxNotes = 1 + Math.floor(Math.random() * 3);
    const remaining = unique.filter((i) => i !== pool[0]);
    const preferred = remaining.filter((i) => i === 5 || i === 7 || i === 2 || i === 9 || i === 10);

    while (pool.length < maxNotes && (preferred.length || remaining.length)) {
      const source = preferred.length ? preferred : remaining;
      const index = Math.floor(Math.random() * source.length);
      const picked = source.splice(index, 1)[0];
      pool.push(picked);
      const remainingIndex = remaining.indexOf(picked);
      if (remainingIndex >= 0) remaining.splice(remainingIndex, 1);
    }

    return pool.sort((a, b) => a - b);
  }

  private getScaleForQuantize(scale: ScaleDef): ScaleDef {
    if (!scale.tags?.includes('drone')) return scale;

    const needsRefresh =
      this.droneScaleId !== scale.id ||
      !this.dronePool ||
      this.droneTriggerCount % 12 === 0;

    if (needsRefresh) {
      this.droneScaleId = scale.id;
      this.dronePool = this.buildDronePool(scale.intervals);
    }

    this.droneTriggerCount += 1;
    return { ...scale, intervals: this.dronePool ?? scale.intervals };
  }

  public updateSettings(settings: AudioSettings) {
    this.lastAudioSettings = settings;
    const safeVol = Number.isFinite(settings.volume) ? clamp(settings.volume, 0, 1) : this.desiredMasterGain;
    this.desiredMasterGain = safeVol;
    if (!this.ctx) return;

    if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(safeVol, this.ctx.currentTime, 0.1);
    }

    if (this.compressorNode && this.makeupGain) {
        const thr = Number.isFinite(settings.compThreshold ?? NaN) ? settings.compThreshold! : -12;
        const ratio = Number.isFinite(settings.compRatio ?? NaN) ? settings.compRatio! : 3;
        const att = Number.isFinite(settings.compAttack ?? NaN) ? settings.compAttack! : 0.0001;
        const rel = Number.isFinite(settings.compRelease ?? NaN) ? settings.compRelease! : 0.5;
        const makeupDb = Number.isFinite(settings.makeupGainDb ?? NaN) ? settings.makeupGainDb! : 0;
        this.compressorNode.threshold.setTargetAtTime(thr, this.ctx.currentTime, 0.05);
        this.compressorNode.ratio.setTargetAtTime(ratio, this.ctx.currentTime, 0.05);
        this.compressorNode.attack.setTargetAtTime(att, this.ctx.currentTime, 0.05);
        this.compressorNode.release.setTargetAtTime(rel, this.ctx.currentTime, 0.05);
        const lin = Math.pow(10, makeupDb / 20);
        this.makeupGain.gain.setTargetAtTime(clamp(lin, 0.1, 8), this.ctx.currentTime, 0.05);
    }

    if (this.limiterNode) {
        const limThr = Number.isFinite(settings.limiterThreshold ?? NaN) ? settings.limiterThreshold! : -1;
        this.limiterNode.threshold.setTargetAtTime(limThr, this.ctx.currentTime, 0.02);
    }

    if (this.lowEQ) this.lowEQ.gain.setTargetAtTime(settings.low || 0, this.ctx.currentTime, 0.1);
    if (this.midEQ) this.midEQ.gain.setTargetAtTime(settings.mid || 0, this.ctx.currentTime, 0.1);
    if (this.highEQ) this.highEQ.gain.setTargetAtTime(settings.high || 0, this.ctx.currentTime, 0.1);

    if (this.reverbGain && this.dryGain) {
        const wetRaw = Number.isFinite(settings.reverbWet) ? settings.reverbWet : 0.3;
        const wet = applyWetBoost(wetRaw);
        this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.1);
        this.dryGain.gain.setTargetAtTime(1 - (wet * 0.5), this.ctx.currentTime, 0.1);
    }

    const pingWetRaw = Number.isFinite(settings.pingPongWet) ? settings.pingPongWet : 0;
    this.updatePingPongParams(pingWetRaw, settings.baseFrequency);
  }

  private updatePingPongParams(raw: number, baseFrequency?: number) {
    if (!this.ctx) return;
    const safe = clamp(raw, 0, 1);
    const wet = applyWetBoost(safe);
    if (this.pingPongReturn) {
      this.pingPongReturn.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.1);
    }

    const tail = Math.pow(safe, 1.3);
    const feedback = clamp(0.2 + tail * 0.7, 0.2, 0.9);
    if (this.feedbackL) this.feedbackL.gain.setTargetAtTime(feedback, this.ctx.currentTime, 0.15);
    if (this.feedbackR) this.feedbackR.gain.setTargetAtTime(feedback, this.ctx.currentTime, 0.15);

    this.updatePingPongDelayTimes(baseFrequency);

    if (this.granularNode) {
      const stretch = 1 + wet * 0.8;
      const grain = 0.05 + wet * 0.07;
      this.granularNode.parameters.get('stretch')?.setTargetAtTime(stretch, this.ctx.currentTime, 0.05);
      this.granularNode.parameters.get('mix')?.setTargetAtTime(1, this.ctx.currentTime, 0.05);
      this.granularNode.parameters.get('grainSize')?.setTargetAtTime(grain, this.ctx.currentTime, 0.05);
    }
  }

  private updatePingPongDelayTimes(baseFrequency?: number) {
    if (!this.ctx || !this.delayL || !this.delayR) return;
    const baseFreq = (Number.isFinite(baseFrequency) && (baseFrequency ?? 0) > 0)
      ? baseFrequency!
      : (Number.isFinite(this.lastAudioSettings?.baseFrequency) ? this.lastAudioSettings!.baseFrequency : 220);
    const music = this.lastMusicSettings;
    const rootPc = Number.isFinite(music?.root) ? music!.root : 0;
    const rootMidi = snapMidiToPitchClass(freqToMidi(baseFreq), rootPc);
    const rootFreq = midiToFreq(rootMidi);
    const scale = getScaleById(music?.scaleId);
    const intervals = scale.intervals.length ? scale.intervals : [0];
    let secondary = intervals.includes(7) ? 7 : intervals[Math.min(3, intervals.length - 1)] ?? 0;
    if (secondary === 0 && intervals.length > 1) secondary = intervals[1];

    const ratioL = 1;
    const ratioR = Math.pow(2, secondary / 12);
    const basePeriod = 1 / Math.max(30, rootFreq);
    const target = 0.45;
    const mult = Math.max(1, Math.round(target / basePeriod));
    let baseTime = clamp(basePeriod * mult, 0.24, 0.85);

    let left = baseTime * ratioL;
    let right = baseTime * ratioR;
    const maxVal = Math.max(left, right);
    if (maxVal > 0.85) {
      const scaleDown = 0.85 / maxVal;
      left *= scaleDown;
      right *= scaleDown;
    }
    const minVal = Math.min(left, right);
    if (minVal < 0.22) {
      const scaleUp = 0.22 / minVal;
      left *= scaleUp;
      right *= scaleUp;
    }
    left = clamp(left, 0.22, 0.85);
    right = clamp(right, 0.22, 0.85);

    const last = this.lastDelayTimes;
    const eps = 0.002;
    const timeConst = 0.25;
    if (!last || Math.abs(left - last.left) > eps) {
      this.delayL.delayTime.setTargetAtTime(left, this.ctx.currentTime, timeConst);
    }
    if (!last || Math.abs(right - last.right) > eps) {
      this.delayR.delayTime.setTargetAtTime(right, this.ctx.currentTime, timeConst);
    }
    if (!last || Math.abs(left - last.left) > eps || Math.abs(right - last.right) > eps) {
      this.lastDelayTimes = { left, right };
    }
  }

  private getLoadedLabels(): string[] {
    const labels: string[] = [];
    this.micBank.forEach((buf, idx) => { if (buf) labels.push(`M0${idx + 1}`); });
    this.sampleBank.forEach((buf, idx) => { if (buf) labels.push(`S0${idx + 1}`); });
    if (this.synthEnabled) labels.push('SNT');
    return labels;
  }

  public getBankSnapshot() {
    return {
      mic: this.micBank.map((b) => Boolean(b)),
      smp: this.sampleBank.map((b) => Boolean(b)),
      loadedLabels: this.getLoadedLabels(),
      synthEnabled: this.synthEnabled,
      activePoolSize: this.playPool.length,
    };
  }

  public isMicBankFull(): boolean {
    return this.micBank.every(Boolean);
  }

  public getActivePoolSize(): number {
    return this.playPool.length;
  }

  public getActivePoolInfo(): { size: number; labels: string[] } {
    return {
      size: this.playPool.length,
      labels: this.playPool.map((choice) => {
        if (choice.type === 'synth') return 'SYNTH';
        if (choice.type === 'mic' && typeof choice.index === 'number') return `M${String(choice.index + 1).padStart(2, '0')}`;
        if (choice.type === 'smp' && typeof choice.index === 'number') return `S${String(choice.index + 1).padStart(2, '0')}`;
        return '---';
      }),
    };
  }

  private updatePlayPool() {
    const options: SourceChoice[] = [];
    this.sampleBank.forEach((buf, idx) => { if (buf) options.push({ type: 'smp', index: idx }); });
    this.micBank.forEach((buf, idx) => { if (buf) options.push({ type: 'mic', index: idx }); });
    if (this.synthEnabled) options.push({ type: 'synth' });

    if (options.length === 0) {
      this.playPool = [];
      this.playCursor = 0;
      return;
    }

    const target = options.length >= 9 ? 9 : options.length >= 6 ? 6 : options.length > 0 ? 3 : 0;
    const shuffled = [...options];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const pool: SourceChoice[] = [];
    for (let i = 0; i < shuffled.length && pool.length < target; i++) {
      pool.push(shuffled[i]);
    }
    while (pool.length < target && pool.length > 0) {
      pool.push(pool[pool.length % options.length] ?? pool[0]);
    }

    this.playPool = pool;
    this.playCursor = 0;
  }

  private pickSource(): SourceChoice | null {
    if (!this.playPool.length) {
      return this.synthEnabled ? { type: 'synth' } : null;
    }
    const choice = this.playPool[this.playCursor % this.playPool.length];
    this.playCursor = (this.playCursor + 1) % this.playPool.length;
    return choice;
  }

  public assignSourceToBubble(): SourceChoice | null {
    return this.pickSource();
  }

  public setSynthEnabled(enabled: boolean) {
    this.synthEnabled = enabled;
    this.updatePlayPool();
  }

  public clearMicSlot(index: number) {
    if (index < 0 || index >= this.micBank.length) return;
    this.micBank[index] = null;
    this.updatePlayPool();
  }

  public clearSampleSlot(index: number) {
    if (index < 0 || index >= this.sampleBank.length) return;
    this.sampleBank[index] = null;
    this.updatePlayPool();
  }

  public clearAllSamples() {
    this.micBank = new Array(6).fill(null);
    this.sampleBank = new Array(6).fill(null);
    this.customBuffer = null;
    this.soundType = SoundType.SYNTH;
    this.updatePlayPool();
  }

  private findSlot(bank: (AudioBuffer | null)[], startIndex: number): number {
    for (let i = startIndex; i < bank.length; i++) {
      if (!bank[i]) return i;
    }
    for (let i = 0; i < startIndex; i++) {
      if (!bank[i]) return i;
    }
    return -1;
  }

  public async loadSampleFiles(
    files: FileList | File[],
    startIndex: number = 0,
    opts?: { overwrite?: boolean }
  ): Promise<{ loaded: number; skipped: number; }> {
    const arr = Array.from(files).slice(0, 6);
    await this.init();
    if (!this.ctx) return { loaded: 0, skipped: arr.length };
    let slot = Math.max(0, Math.min(5, startIndex));
    const overwrite = Boolean(opts?.overwrite);
    let loaded = 0;
    let skipped = 0;

    for (const file of arr) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arrayBuffer);
        if (buf.duration > 10.0) {
          skipped += 1;
          console.warn(`Sample too long (>10s): ${file.name}`);
          continue;
        }
        const targetSlot = overwrite ? slot : this.findSlot(this.sampleBank, slot);
        if (targetSlot === -1) {
          skipped += 1;
          continue;
        }
        this.sampleBank[targetSlot] = buf;
        loaded += 1;
        if (overwrite && targetSlot >= 5) break;
        slot = Math.min(5, targetSlot + 1);
      } catch (e) {
        skipped += 1;
        console.error('Failed to load sample', e);
      }
    }

    this.updatePlayPool();
    return { loaded, skipped };
  }

  public async loadMicSampleBlob(blob: Blob, targetSlot?: number): Promise<boolean> {
    await this.init();
    if (!this.ctx) return false;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arrayBuffer);
      if (buf.duration > 10.0) {
        console.warn('Recorded sample too long (>10s), rejecting.');
        return false;
      }
      let slot = typeof targetSlot === 'number'
        ? Math.max(0, Math.min(5, targetSlot))
        : this.findSlot(this.micBank, this.micInsertIndex);
      if (slot === -1) {
        console.warn('Mic bank full, recording rejected.');
        return false;
      }
      this.micBank[slot] = buf;
      this.micInsertIndex = (slot + 1) % this.micBank.length;
      this.updatePlayPool();
      return true;
    } catch (e) {
      console.error('Failed to load mic sample', e);
      return false;
    }
  }

  public async loadSample(file: File) {
    await this.loadSampleFiles([file]);
  }

  public async loadSampleBlob(blob: Blob) {
    await this.init();
    if (!this.ctx) return;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arrayBuffer);
      if (buf.duration > 10.0) {
        console.warn('Recorded sample too long (>10s), rejecting.');
        return;
      }
      const target = this.findSlot(this.sampleBank, 0);
      if (target !== -1) {
        this.sampleBank[target] = buf;
        this.updatePlayPool();
      }
    } catch (e) {
      console.error("Failed to load sample from blob", e);
    }
  }

  public setMicGain(value: number) {
    const safe = Math.max(0, Math.min(4, value));
    this.desiredMicGain = safe;
    if (!this.ctx || !this.micGain) return;
    this.micGain.gain.setTargetAtTime(safe, this.ctx.currentTime, 0.05);
  }

  public setMasterGain(value: number) {
    const safe = Number.isFinite(value) ? clamp(value, 0, 1) : this.desiredMasterGain;
    this.desiredMasterGain = safe;
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(safe, this.ctx.currentTime, 0.1);
  }

  public setEqGains(low: number, mid: number, high: number) {
    if (!this.ctx) return;
    const safeLow = Number.isFinite(low) ? clamp(low, -24, 24) : 0;
    const safeMid = Number.isFinite(mid) ? clamp(mid, -24, 24) : 0;
    const safeHigh = Number.isFinite(high) ? clamp(high, -24, 24) : 0;
    if (this.lowEQ) this.lowEQ.gain.setTargetAtTime(safeLow, this.ctx.currentTime, 0.05);
    if (this.midEQ) this.midEQ.gain.setTargetAtTime(safeMid, this.ctx.currentTime, 0.05);
    if (this.highEQ) this.highEQ.gain.setTargetAtTime(safeHigh, this.ctx.currentTime, 0.05);
  }

  public setPingPongWet(value: number) {
    const safe = Number.isFinite(value) ? clamp(value, 0, 1) : 0;
    if (this.lastAudioSettings) {
      this.lastAudioSettings = { ...this.lastAudioSettings, pingPongWet: safe };
    }
    this.updatePingPongParams(safe, this.lastAudioSettings?.baseFrequency);
  }

  public setReverbWet(value: number) {
    const safe = Number.isFinite(value) ? clamp(value, 0, 1) : 0;
    if (this.lastAudioSettings) {
      this.lastAudioSettings = { ...this.lastAudioSettings, reverbWet: safe };
    }
    if (!this.ctx || !this.reverbGain || !this.dryGain) return;
    const wet = applyWetBoost(safe);
    this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.1);
    this.dryGain.gain.setTargetAtTime(1 - (wet * 0.5), this.ctx.currentTime, 0.1);
  }

  public setSpatialControl(pan: number, depth: number, width: number) {
    this.spatialControl = {
      pan: clamp(pan, -1, 1),
      depth: clamp(depth, -1, 1),
      width: clamp(width, -1, 1),
    };
  }

  public getMicStream(): MediaStream | null {
    return this.micStream;
  }

  public getMicRecordStream(): MediaStream | null {
    return this.micRecordDest?.stream ?? this.micStream;
  }

  public attachMicStream(stream: MediaStream) {
    if (!this.ctx) return;

    try { this.micSource?.disconnect(); } catch { /* ignore */ }
    this.micSource = null;

    this.micStream = stream;
    const src = this.ctx.createMediaStreamSource(stream);
    this.micSource = src;

    if (!this.micGain) {
      this.micGain = this.ctx.createGain();
      this.micGain.gain.value = this.desiredMicGain;
    }
    if (this.micComp && this.micGain) {
      try { this.micGain.disconnect(); } catch { /* ignore */ }
      this.micGain.connect(this.micComp);
    }
    src.connect(this.micGain);
  }

  public async ensureMic(opts?: { fromUserGesture?: boolean }) {
    await this.init();
    if (!this.ctx) return;

    const fromUserGesture = opts?.fromUserGesture ?? false;
    if (fromUserGesture) {
      this.lastUserGestureAt = performance.now();
      await this.resume();
    }

    if (this.micStream) {
      const hasLiveTrack = this.micStream.getTracks().some((t) => t.readyState === 'live');
      if (!hasLiveTrack) {
        try { this.micSource?.disconnect(); } catch { /* ignore */ }
        this.micSource = null;
        this.micStream = null;
      }
    }

    if (this.micStream) return;

    if (this.micEnsureInFlight) {
      await this.micEnsureInFlight;
      return;
    }

    try {
      this.micEnsureInFlight = (async () => {
        const constraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            sampleRate: 48000,
          },
        };
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        stream.getAudioTracks().forEach((t) => { t.enabled = true; });
        this.attachMicStream(stream);
        if (this.ctx && this.ctx.state !== 'running') {
          try { await this.ctx.resume(); } catch { /* ignore */ }
        }
      })();
      await this.micEnsureInFlight;
    } catch (e) {
      console.error('Mic access failed', e);
    } finally {
      this.micEnsureInFlight = null;
    }
  }

  public getMicLevelDb(): number {
    if (!this.micMeter) return -120;
    const data = new Uint8Array(this.micMeter.frequencyBinCount);
    this.micMeter.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      peak = Math.max(peak, Math.abs(v));
    }
    const db = 20 * Math.log10(peak || 1e-5);
    return db;
  }

  public clearSample() {
    this.clearAllSamples();
  }

  public isSampleLoaded() {
    return this.micBank.some(Boolean) || this.sampleBank.some(Boolean);
  }

  public setSoundType(mode: SoundType) {
    this.soundType = mode;
    if (mode === SoundType.SYNTH) this.synthEnabled = true;
    this.updatePlayPool();
  }

  public triggerSound(
    sizeFactor: number, 
    baseFreq: number, 
    pan: number = 0, 
    depth: number = 0, 
    velocityZ: number = 0,
    dopplerIntensity: number = 0,
    isReverse: boolean = false, 
    volume: number = 0.5,
    music?: MusicSettings,
    sampleGain: number = 1,
    sourceOverride?: SourceChoice | null
  ) {
    if (!this.ctx) return;
    let ctxState = this.ctx.state;
    if (ctxState !== 'running') {
      if (!this.shouldPlay) return;
      void this.resume();
      ctxState = this.ctx.state;
      if (ctxState !== 'running') return;
    }

    if (this.activeVoices >= this.MAX_VOICES) {
        return; 
    }
    this.activeVoices++;

    const safeBaseFreq = (Number.isFinite(baseFreq) && baseFreq > 0) ? baseFreq : 440;
    const safePan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    const safeDepth = Number.isFinite(depth) ? depth : 0;
    const safeVolume = (Number.isFinite(volume) && volume >= 0) ? volume : 0.5;
    const safeSampleGain = (Number.isFinite(sampleGain) && sampleGain >= 0) ? clamp(sampleGain, 0, 2) : 1;
    const safeMusic: MusicSettings = {
      root: Number.isFinite(music?.root) ? (music?.root ?? 0) : 0,
      scaleId: music?.scaleId ?? getScaleById().id,
      scaleIndex: Number.isFinite(music?.scaleIndex) ? (music?.scaleIndex ?? 0) : 0,
      quantizeEnabled: music?.quantizeEnabled ?? true,
      noImmediateRepeat: music?.noImmediateRepeat ?? false,
      avoidLeadingTone: music?.avoidLeadingTone ?? false,
      noThirds: music?.noThirds ?? false,
    };
    this.lastMusicSettings = safeMusic;

    const now = this.ctx.currentTime;
    
    // --- SPATIAL CHAIN ---
    const spatial = this.spatialControl;
    const panWith = clamp(safePan + spatial.pan * 0.9, -1, 1);
    const depthWith = clamp(safeDepth + spatial.depth * 0.6, 0, 1);
    const widthScale = clamp(1 + spatial.width * 1.1, 0.2, 2.2);

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 6;
    panner.rolloffFactor = 0;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;
    panner.positionX.setValueAtTime(panWith * 2.2 * widthScale, now);
    panner.positionY.setValueAtTime(0, now);
    panner.positionZ.setValueAtTime(-0.6 - (depthWith * 4.6), now);

    const depthFilter = this.ctx.createBiquadFilter();
    depthFilter.type = 'lowpass';
    const minCutoff = 1000;
    const maxCutoff = 22000;
    const cutoff = maxCutoff * Math.pow(minCutoff / maxCutoff, depthWith);
    depthFilter.frequency.value = cutoff;
    depthFilter.Q.value = 0; 

    depthFilter.connect(panner);

    const sourceGain = this.ctx.createGain();
    panner.connect(sourceGain);
    
    sourceGain.connect(this.dryGain!);
    sourceGain.connect(this.reverbNode!);
    if (this.pingPongInput) sourceGain.connect(this.pingPongInput);

    // --- PITCH SELECTION ---
    const baseMidi = freqToMidi(safeBaseFreq);
    const rootMidi = snapMidiToPitchClass(baseMidi, safeMusic.root);
    const scale = getScaleById(safeMusic.scaleId);
    const scaleForQuantize = this.getScaleForQuantize(scale);

    const octaveShift = sizeFactor > 0.8 ? -12 : sizeFactor < 0.3 ? 12 : 0;
    const depthOffset = (safeDepth - 0.5) * 6;
    const randomOffset = (Math.random() - 0.5) * 12;
    const inputMidi = rootMidi + octaveShift + depthOffset + randomOffset;

    let finalMidi = inputMidi;
    if (safeMusic.quantizeEnabled) {
        finalMidi = quantizeMidiToScale(inputMidi, {
          rootMidi,
          scale: scaleForQuantize,
          mode: 'nearest',
          octaveWrap: true,
          noImmediateRepeat: safeMusic.noImmediateRepeat,
          lastMidi: this.lastMidi,
          avoidLeadingTone: safeMusic.avoidLeadingTone,
          noThirds: safeMusic.noThirds,
        });
    }

    this.lastMidi = Math.round(finalMidi);
    let finalFreq = midiToFreq(finalMidi);

    // Safety checks for Physics anomalies
    if (dopplerIntensity > 0 && Number.isFinite(velocityZ)) {
       const dopplerCents = velocityZ * -100 * dopplerIntensity; 
       const multiplier = Math.pow(2, dopplerCents / 1200);
       finalFreq *= multiplier;
    }

    // Ensure Frequency is Finite and within audible range
    if (!Number.isFinite(finalFreq) || Number.isNaN(finalFreq)) {
        finalFreq = 440;
    }
    finalFreq = Math.max(40, Math.min(12000, finalFreq));

    // --- GAIN STAGING ---
    const baseVol = 0.25 * safeVolume; 
    
    // Use an Epsilon to prevent exponentialRampToValueAtTime errors when starting from 0
    const EPSILON = 0.001; 
    const peakVol = Math.max(EPSILON, baseVol);

    const cleanup = () => {
        this.activeVoices = Math.max(0, this.activeVoices - 1);
        setTimeout(() => {
            try {
                sourceGain.disconnect();
                panner.disconnect();
                depthFilter.disconnect();
            } catch (e) { /* ignore */ }
        }, 1000);
    };

    let sourceChoice = sourceOverride ?? this.pickSource();
    if (sourceChoice?.type === 'synth' && !this.synthEnabled) {
      sourceChoice = null;
    }
    const sampleBuffer =
      sourceChoice?.type === 'mic' && typeof sourceChoice.index === 'number'
        ? this.micBank[sourceChoice.index] ?? null
        : sourceChoice?.type === 'smp' && typeof sourceChoice.index === 'number'
        ? this.sampleBank[sourceChoice.index] ?? null
        : null;

    if (!sampleBuffer && sourceChoice?.type !== 'synth') {
        cleanup();
        return;
    }

    if (sampleBuffer) {
        const source = this.ctx.createBufferSource();
        const bufferToUse = isReverse ? this.createReverseBuffer(sampleBuffer) : sampleBuffer;
        source.buffer = bufferToUse;
        let rate = finalFreq / 440; 
        if (!Number.isFinite(rate)) rate = 1.0;
        
        source.playbackRate.setValueAtTime(Math.max(0.1, Math.min(rate, 4.0)), now);

        const duration = bufferToUse.duration / rate;
        const targetGain = peakVol * safeSampleGain;
        const attack = Math.min(0.01, duration * 0.2);
        const fadeOut = Math.min(0.08, duration * 0.3);
        const fadeStart = now + Math.max(attack, duration - fadeOut);

        sourceGain.gain.setValueAtTime(EPSILON, now);
        sourceGain.gain.linearRampToValueAtTime(targetGain, now + attack);
        sourceGain.gain.setValueAtTime(targetGain, fadeStart);
        sourceGain.gain.exponentialRampToValueAtTime(EPSILON, now + duration);
        
        source.connect(depthFilter);
        source.onended = cleanup;
        source.start();
    } else {
        // --- SYNTHESIS ---
        const osc = this.ctx.createOscillator();
        osc.type = 'sine'; 
        osc.frequency.setValueAtTime(finalFreq, now);

        if (sizeFactor < 0.4) {
             const fmOsc = this.ctx.createOscillator();
             const fmGain = this.ctx.createGain();
             fmOsc.type = 'sine';
             fmOsc.frequency.value = finalFreq * 2.5;
             fmGain.gain.value = finalFreq * 0.3; 
             fmOsc.connect(fmGain);
             fmGain.connect(osc.frequency);
             fmOsc.start(now);
             fmOsc.stop(now + 0.3);
        }

        osc.connect(depthFilter);

        // --- ENVELOPE ---
        const attack = 0.005;
        const decay = 1.5;
        const release = 0.06;

        // Start at silence (EPSILON)
        sourceGain.gain.setValueAtTime(EPSILON, now);
        // Linear ramp to peak
        sourceGain.gain.linearRampToValueAtTime(peakVol, now + attack);
        // Exponential ramp back to silence (safe because start value is peakVol >= EPSILON)
        sourceGain.gain.exponentialRampToValueAtTime(EPSILON, now + decay);
        sourceGain.gain.setValueAtTime(EPSILON, now + decay + release);

        osc.start(now);
        osc.stop(now + decay + release);
        osc.onended = cleanup;
    }
  }

  private createReverseBuffer(buffer: AudioBuffer): AudioBuffer {
      if (!this.ctx) return buffer;
      const revBuffer = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let i = 0; i < buffer.numberOfChannels; i++) {
          const dest = revBuffer.getChannelData(i);
          const src = buffer.getChannelData(i);
          for (let j = 0; j < src.length; j++) {
              dest[j] = src[src.length - 1 - j];
          }
      }
      return revBuffer;
  }

  public getContextState(): string | null {
    if (!this.ctx) return null;
    return ((this.ctx as any).state as string) ?? this.ctx.state ?? null;
  }
}

export const audioService = new AudioEngine();
