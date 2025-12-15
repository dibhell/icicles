import { AudioSettings, SoundType } from '../types';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null; 
  private analyser: AnalyserNode | null = null; 
  
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

  // --- SCALES & MODES ---
  // Just Intonation approximations for smoother beating

  // 1. Major Pentatonic (Bright, Airy): 1, 2, 3, 5, 6
  // Ratios: 1, 9/8, 5/4, 3/2, 5/3
  private majorPentatonic = [1, 1.125, 1.25, 1.5, 1.667]; 

  // 2. Minor Pentatonic (Deep, Ambient): 1, b3, 4, 5, b7
  // Ratios: 1, 6/5, 4/3, 3/2, 9/5
  private minorPentatonic = [1, 1.2, 1.333, 1.5, 1.8];

  // 3. Dorian Mode (Mysterious, Folk): 1, 2, b3, 4, 5, 6, b7
  private dorianMode = [1, 1.125, 1.2, 1.333, 1.5, 1.667, 1.8];

  // 4. Lydian Mode (Dreamy, Sci-Fi): 1, 2, 3, #4, 5, 6, 7
  private lydianMode = [1, 1.125, 1.25, 1.414, 1.5, 1.667, 1.875];

  // 5. Chromatic / Microtonal (Chaos)
  private chromaticScale = [1, 1.059, 1.122, 1.189, 1.259, 1.334, 1.414, 1.498, 1.587, 1.681, 1.781, 1.887];

  public init() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Analyser
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256; 
    this.analyser.smoothingTimeConstant = 0.6; 

    // TRANSPARENT LIMITER (Safety net)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1.0; 
    this.limiterNode.knee.value = 10; 
    this.limiterNode.ratio.value = 20; 
    this.limiterNode.attack.value = 0.002;
    this.limiterNode.release.value = 0.2;

    // Master Gain - Boosted significantly
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0; 

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
    this.highEQ.connect(this.masterGain);
    
    this.masterGain.connect(this.limiterNode);
    this.limiterNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  public getPeakLevel(): number {
    if (!this.analyser) return -100;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    
    let max = 0;
    for(let i = 0; i < data.length; i++) {
        if(Math.abs(data[i]) > max) max = Math.abs(data[i]);
    }
    if (max === 0) return -100;
    return 20 * Math.log10(max);
  }

  public resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public suspend() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend();
    }
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

  public updateSettings(settings: AudioSettings) {
    if (!this.ctx) return;

    if (this.masterGain) {
        const safeVol = Number.isFinite(settings.volume) ? settings.volume : 0;
        this.masterGain.gain.setTargetAtTime(safeVol, this.ctx.currentTime, 0.1);
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
        this.customBuffer = await this.ctx.decodeAudioData(arrayBuffer);
        this.soundType = SoundType.SAMPLE;
    } catch (e) {
        console.error("Failed to load sample", e);
    }
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
    toneMatch: number = 0.5
  ) {
    if (!this.ctx || this.ctx.state !== 'running') return;

    if (this.activeVoices >= this.MAX_VOICES) {
        return; 
    }
    this.activeVoices++;

    const safeBaseFreq = (Number.isFinite(baseFreq) && baseFreq > 0) ? baseFreq : 440;
    const safePan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    const safeDepth = Number.isFinite(depth) ? depth : 0;
    const safeVolume = (Number.isFinite(volume) && volume >= 0) ? volume : 0.5;
    const safeToneMatch = Number.isFinite(toneMatch) ? toneMatch : 0.5;

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

    // --- HARMONIC QUANTIZATION LOGIC ---
    let scale = this.chromaticScale;
    
    // Select scale based on toneMatch slider (Creative Group -> Tone)
    if (safeToneMatch > 0.8) {
        scale = this.majorPentatonic; // Very Consonant
    } else if (safeToneMatch > 0.6) {
        scale = this.minorPentatonic; // Ambient/Moody
    } else if (safeToneMatch > 0.4) {
        scale = this.dorianMode; // Folk/Mysterious
    } else if (safeToneMatch > 0.2) {
        scale = this.lydianMode; // Dreamy/Floaty
    }
    // Else: Chromatic (Chaos)

    const intervalIndex = Math.floor(Math.random() * scale.length);
    const interval = scale[intervalIndex];
    
    const octave = sizeFactor > 0.8 ? 0.5 : sizeFactor < 0.3 ? 2 : 1;
    let finalFreq = safeBaseFreq * interval * octave;

    if (dopplerIntensity > 0) {
       const dopplerCents = velocityZ * -100 * dopplerIntensity; 
       const multiplier = Math.pow(2, dopplerCents / 1200);
       finalFreq *= multiplier;
    }
    
    finalFreq = Math.max(40, Math.min(12000, finalFreq));

    // --- GAIN STAGING ---
    const baseVol = 0.25 * safeVolume; 
    
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
        source.playbackRate.setValueAtTime(Math.max(0.1, Math.min(rate, 4.0)), now);
        
        sourceGain.gain.setValueAtTime(baseVol, now);
        sourceGain.gain.exponentialRampToValueAtTime(0.0001, now + (this.customBuffer.duration / rate));
        
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

        sourceGain.gain.setValueAtTime(0, now);
        sourceGain.gain.linearRampToValueAtTime(baseVol, now + attack);
        sourceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

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
}

export const audioService = new AudioEngine();