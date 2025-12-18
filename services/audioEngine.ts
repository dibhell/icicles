import { AudioSettings, MusicSettings, SoundType } from '../types';
import { getScaleById } from '../src/music/scales';
import type { ScaleDef } from '../src/music/scales';
import { freqToMidi, midiToFreq, snapMidiToPitchClass } from '../src/music/notes';
import { quantizeMidiToScale } from '../src/music/quantize';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private makeupGain: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private mainAnalyser: AnalyserNode | null = null;
  private peakAnalyser: AnalyserNode | null = null;
  private micGain: GainNode | null = null;
  private micMeter: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  
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
  
  // EQ Nodes
  private lowEQ: BiquadFilterNode | null = null;
  private midEQ: BiquadFilterNode | null = null;
  private highEQ: BiquadFilterNode | null = null;

  private customBuffer: AudioBuffer | null = null;
  private soundType: SoundType = SoundType.SYNTH;

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
    this.micMeter = this.ctx.createAnalyser();
    this.micMeter.fftSize = 1024;
    this.micMeter.smoothingTimeConstant = 0.65;
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
    this.masterGain.gain.value = 1.0; 

    // Mic chain (muted to master, for metering only)
    this.micGain = this.ctx.createGain();
    this.micGain.gain.value = 0;
    const micSilent = this.ctx.createGain();
    micSilent.gain.value = 0;
    if (this.micMeter) {
      this.micGain.connect(this.micMeter);
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
    this.pingPongInput.gain.value = 0; 
    this.delayL = this.ctx.createDelay();
    this.delayR = this.ctx.createDelay();
    this.feedbackL = this.ctx.createGain();
    this.feedbackR = this.ctx.createGain();
    this.pingPongMerger = this.ctx.createChannelMerger(2);

    this.delayL.delayTime.value = 0.35; 
    this.delayR.delayTime.value = 0.5; 
    this.feedbackL.gain.value = 0.3; 
    this.feedbackR.gain.value = 0.3;

    this.pingPongInput.connect(this.delayL);
    this.delayL.connect(this.pingPongMerger, 0, 0);
    this.delayL.connect(this.feedbackL).connect(this.delayR);
    this.delayR.connect(this.pingPongMerger, 0, 1);
    this.delayR.connect(this.feedbackR).connect(this.delayL);

    // --- MAIN ROUTING ---
    this.reverbNode.connect(this.reverbGain);
    
    this.reverbGain.connect(this.lowEQ);
    this.dryGain.connect(this.lowEQ);
    this.pingPongMerger.connect(this.lowEQ);

    this.lowEQ.connect(this.midEQ);
    this.midEQ.connect(this.highEQ);
    // highEQ -> compressor -> makeup -> limiter -> main analyser -> destination
    this.highEQ.connect(this.compressorNode);
    this.compressorNode.connect(this.makeupGain);
    this.makeupGain.connect(this.limiterNode);
    // tap peak before limiter
    this.makeupGain.connect(this.peakAnalyser);
    this.limiterNode.connect(this.mainAnalyser);
    this.mainAnalyser.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.installLifecycle();
    this.installGestureUnlock();

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

  public getMainLevel(): number {
    return AudioEngine.extractPeakDb(this.mainAnalyser);
  }

  public getPeakLevel(): number {
    return AudioEngine.extractPeakDb(this.peakAnalyser);
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

    const masterGain = this.ctx.createGain();
    masterGain.gain.value = 0.05;

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

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.03;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(masterGain.gain);
    lfo.start();

    this.backgroundDrone = {
      oscillators,
      gains,
      masterGain,
      filter,
      lfo,
      lfoGain,
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
    if (!this.ctx) return;

    if (this.masterGain) {
        const safeVol = Number.isFinite(settings.volume) ? settings.volume : 0;
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
        const wet = Number.isFinite(settings.reverbWet) ? settings.reverbWet : 0.3;
        this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.1);
        this.dryGain.gain.setTargetAtTime(1 - (wet * 0.5), this.ctx.currentTime, 0.1);
    }

    if (this.pingPongInput) {
        const pingWet = Number.isFinite(settings.pingPongWet) ? settings.pingPongWet : 0;
        this.pingPongInput.gain.setTargetAtTime(pingWet, this.ctx.currentTime, 0.1);
    }
  }

  public async loadSample(file: File) {
    if (!this.ctx) return;
    try {
        const arrayBuffer = await file.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arrayBuffer);
        if (buf.duration > 10.0) {
            console.warn('Sample too long (>10s), rejecting.');
            return;
        }
        this.customBuffer = buf;
        this.soundType = SoundType.SAMPLE;
    } catch (e) {
        console.error("Failed to load sample", e);
    }
  }

  public async loadSampleBlob(blob: Blob) {
    if (!this.ctx) return;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arrayBuffer);
      if (buf.duration > 10.0) {
        console.warn('Recorded sample too long (>10s), rejecting.');
        return;
      }
      this.customBuffer = buf;
      this.soundType = SoundType.SAMPLE;
    } catch (e) {
      console.error("Failed to load sample from blob", e);
    }
  }

  public setMicGain(value: number) {
    if (!this.ctx || !this.micGain) return;
    const safe = Math.max(0, Math.min(4, value));
    this.micGain.gain.setTargetAtTime(safe, this.ctx.currentTime, 0.05);
  }

  public async ensureMic() {
    if (!this.ctx) return;
    if (this.micStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = stream;
      const src = this.ctx.createMediaStreamSource(stream);
      if (!this.micGain) {
        this.micGain = this.ctx.createGain();
        this.micGain.gain.value = 0;
      }
      src.connect(this.micGain);
    } catch (e) {
      console.error('Mic access failed', e);
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
    this.customBuffer = null;
    this.soundType = SoundType.SYNTH;
  }

  public isSampleLoaded() {
    return this.customBuffer != null && this.soundType === SoundType.SAMPLE;
  }

  public setSoundType(mode: SoundType) {
    this.soundType = mode;
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
    sampleGain: number = 1
  ) {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') {
      if (!this.shouldPlay) return;
      void this.resume();
      if (this.ctx.state !== 'running') return;
    }

    if (this.activeVoices >= this.MAX_VOICES) {
        return; 
    }
    this.activeVoices++;

    const safeBaseFreq = (Number.isFinite(baseFreq) && baseFreq > 0) ? baseFreq : 440;
    const safePan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    const safeDepth = Number.isFinite(depth) ? depth : 0;
    const safeVolume = (Number.isFinite(volume) && volume >= 0) ? volume : 0.5;
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
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = safePan;

    const depthFilter = this.ctx.createBiquadFilter();
    depthFilter.type = 'lowpass';
    const minCutoff = 1000;
    const maxCutoff = 22000;
    const cutoff = maxCutoff * Math.pow(minCutoff / maxCutoff, safeDepth);
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

    if (this.soundType === SoundType.SAMPLE && this.customBuffer) {
        const source = this.ctx.createBufferSource();
        source.buffer = this.customBuffer;
        let rate = finalFreq / 440; 
        if (isReverse) source.buffer = this.createReverseBuffer(this.customBuffer);
        
        // Safety check for rate
        if (!Number.isFinite(rate)) rate = 1.0;
        
        source.playbackRate.setValueAtTime(Math.max(0.1, Math.min(rate, 4.0)), now);
        
        // Start envelope
        sourceGain.gain.setValueAtTime(peakVol * safeSampleGain, now);
        // Exponential fade out
        sourceGain.gain.exponentialRampToValueAtTime(EPSILON, now + (this.customBuffer.duration / rate));
        
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

        // Start at silence (EPSILON)
        sourceGain.gain.setValueAtTime(EPSILON, now);
        // Linear ramp to peak
        sourceGain.gain.linearRampToValueAtTime(peakVol, now + attack);
        // Exponential ramp back to silence (safe because start value is peakVol >= EPSILON)
        sourceGain.gain.exponentialRampToValueAtTime(EPSILON, now + decay);

        osc.start(now);
        osc.stop(now + decay + 0.1);
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
