import * as THREE from "https://unpkg.com/three@0.162.0/build/three.module.js";

const NUM_TRACKS = 4;
const TRACK_COLORS = ["#4f7dff", "#5a9cff", "#53c7c0", "#8d8bff"];

const DEFAULT_TRACK_PARAMS = {
  volume: 0.75,
  pan: 0,
  waveform: "sawtooth",
  osc2Enabled: true,
  oscMix: 0.35,
  detune: 8,
  attack: 0.03,
  decay: 0.2,
  sustain: 0.72,
  release: 0.4,
  filterType: "lowpass",
  filterCutoff: 8000,
  filterResonance: 1.2,
  reverb: 0.18,
  distortion: 0.08,
  phaser: 0.18,
  metallic: 0.12,
  crystalizer: 0.2,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

function midiToNoteName(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const rounded = Math.round(midi);
  const pitch = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${names[pitch]}${octave}`;
}

function generateMajorScaleMidis(count, startMidi = 36) {
  const majorIntervals = [0, 2, 4, 5, 7, 9, 11];
  const result = [];
  let octave = 0;

  while (result.length < count) {
    for (const step of majorIntervals) {
      result.push(startMidi + octave * 12 + step);
      if (result.length === count) {
        break;
      }
    }
    octave += 1;
  }

  return result;
}

function createDistortionCurve(amount) {
  const k = amount;
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }

  return curve;
}

function createReverbImpulse(context, duration = 2.4, decay = 2.2) {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const n = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, decay);
    }
  }

  return impulse;
}

function audioBufferToWavBlob(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel));
  }

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(channelData[channel][i], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

class Track {
  constructor(context, id, masterInput, reverbInput) {
    this.context = context;
    this.id = id;
    this.masterInput = masterInput;
    this.reverbInput = reverbInput;

    this.params = {
      ...DEFAULT_TRACK_PARAMS,
      enabled: true,
    };

    this.events = [];
    this.recordArmed = false;
    this.recordBaseTime = 0;
    this.recordingNote = null;

    this.liveVoices = new Set();
    this.activeVoice = null;

    this.input = context.createGain();
    this.input.gain.value = 1;

    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = this.params.filterCutoff;
    this.filter.Q.value = this.params.filterResonance;

    this.distortion = context.createWaveShaper();
    this.distortion.oversample = "4x";

    this.prePhaser = context.createGain();
    this.phaserAllpass = context.createBiquadFilter();
    this.phaserAllpass.type = "allpass";
    this.phaserAllpass.frequency.value = 700;

    this.phaserDry = context.createGain();
    this.phaserWet = context.createGain();
    this.postPhaser = context.createGain();

    this.crystalDry = context.createGain();
    this.crystalSend = context.createGain();
    this.crystalDelay = context.createDelay(0.8);
    this.crystalHP = context.createBiquadFilter();
    this.crystalHP.type = "highpass";
    this.crystalFeedback = context.createGain();
    this.crystalWet = context.createGain();
    this.postCrystal = context.createGain();

    this.reverbSend = context.createGain();
    this.panNode = context.createStereoPanner();
    this.trackGain = context.createGain();

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.85;

    this.phaserLFO = context.createOscillator();
    this.phaserLFO.type = "sine";
    this.phaserLFO.frequency.value = 0.35;
    this.phaserLfoDepth = context.createGain();
    this.phaserLfoDepth.gain.value = 280;

    this.input.connect(this.filter);
    this.filter.connect(this.distortion);
    this.distortion.connect(this.prePhaser);

    this.prePhaser.connect(this.phaserDry);
    this.phaserDry.connect(this.postPhaser);

    this.prePhaser.connect(this.phaserAllpass);
    this.phaserAllpass.connect(this.phaserWet);
    this.phaserWet.connect(this.postPhaser);

    this.postPhaser.connect(this.crystalDry);
    this.crystalDry.connect(this.postCrystal);

    this.postPhaser.connect(this.crystalSend);
    this.crystalSend.connect(this.crystalDelay);
    this.crystalDelay.connect(this.crystalHP);
    this.crystalHP.connect(this.crystalWet);
    this.crystalWet.connect(this.postCrystal);

    this.crystalHP.connect(this.crystalFeedback);
    this.crystalFeedback.connect(this.crystalDelay);

    this.postCrystal.connect(this.reverbSend);
    this.reverbSend.connect(this.reverbInput);

    this.postCrystal.connect(this.panNode);
    this.panNode.connect(this.trackGain);
    this.trackGain.connect(this.analyser);
    this.analyser.connect(this.masterInput);

    this.phaserLFO.connect(this.phaserLfoDepth);
    this.phaserLfoDepth.connect(this.phaserAllpass.frequency);
    this.phaserLFO.start();

    this.applyParams();
  }

  setParam(name, value) {
    if (!(name in this.params)) {
      return;
    }

    this.params[name] = value;
    this.applyParams();
  }

  setEnabled(enabled) {
    this.params.enabled = Boolean(enabled);
    this.applyParams();
  }

  applyParams() {
    const now = this.context.currentTime;
    const {
      volume,
      enabled,
      pan,
      filterType,
      filterCutoff,
      filterResonance,
      distortion,
      phaser,
      reverb,
      crystalizer,
    } = this.params;

    this.filter.type = filterType;
    this.filter.frequency.setTargetAtTime(filterCutoff, now, 0.015);
    this.filter.Q.setTargetAtTime(filterResonance, now, 0.02);

    const finalVolume = enabled ? volume : 0;
    this.trackGain.gain.setTargetAtTime(finalVolume, now, 0.015);
    this.panNode.pan.setTargetAtTime(pan, now, 0.015);

    if (distortion <= 0.001) {
      this.distortion.curve = null;
    } else {
      this.distortion.curve = createDistortionCurve(80 + distortion * 650);
    }

    this.phaserDry.gain.setTargetAtTime(1 - phaser * 0.85, now, 0.03);
    this.phaserWet.gain.setTargetAtTime(phaser, now, 0.03);
    this.phaserAllpass.frequency.setTargetAtTime(220 + phaser * 1200, now, 0.03);
    this.phaserLFO.frequency.setTargetAtTime(0.08 + phaser * 1.2, now, 0.03);
    this.phaserLfoDepth.gain.setTargetAtTime(50 + phaser * 1500, now, 0.03);

    this.reverbSend.gain.setTargetAtTime(reverb, now, 0.04);

    this.crystalDry.gain.setTargetAtTime(1 - crystalizer * 0.65, now, 0.04);
    this.crystalSend.gain.setTargetAtTime(crystalizer, now, 0.04);
    this.crystalWet.gain.setTargetAtTime(crystalizer * 0.95, now, 0.04);
    this.crystalDelay.delayTime.setTargetAtTime(0.06 + crystalizer * 0.24, now, 0.04);
    this.crystalFeedback.gain.setTargetAtTime(0.12 + crystalizer * 0.55, now, 0.04);
    this.crystalHP.frequency.setTargetAtTime(1300 + crystalizer * 5200, now, 0.04);

    this.updateLiveVoices(now);
  }

  updateLiveVoices(time = this.context.currentTime) {
    for (const voice of this.liveVoices) {
      voice.updateFromTrackParams(time);
    }
  }

  createVoice(frequency, startTime = this.context.currentTime) {
    const ctx = this.context;
    const trackRef = this;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const mix1 = ctx.createGain();
    const mix2 = ctx.createGain();
    const oscBus = ctx.createGain();

    const dryGain = ctx.createGain();
    const ringGain = ctx.createGain();
    const ringWet = ctx.createGain();

    const modOsc = ctx.createOscillator();
    const modDepth = ctx.createGain();

    const envelope = ctx.createGain();
    envelope.gain.value = 0.0001;

    osc1.connect(mix1);
    osc2.connect(mix2);
    mix1.connect(oscBus);
    mix2.connect(oscBus);

    oscBus.connect(dryGain);
    dryGain.connect(envelope);

    oscBus.connect(ringGain);
    ringGain.connect(ringWet);
    ringWet.connect(envelope);

    modOsc.connect(modDepth);
    modDepth.connect(ringGain.gain);

    envelope.connect(this.input);

    const voice = {
      osc1,
      osc2,
      mix1,
      mix2,
      dryGain,
      ringWet,
      modOsc,
      modDepth,
      envelope,
      released: false,
      cleaned: false,
      frequency,
      releaseAt(releaseTime = ctx.currentTime) {
        if (this.released) {
          return;
        }
        this.released = true;

        const releaseSeconds = Math.max(0.01, trackRef.params.release);
        if (typeof envelope.gain.cancelAndHoldAtTime === "function") {
          envelope.gain.cancelAndHoldAtTime(releaseTime);
        } else {
          envelope.gain.cancelScheduledValues(releaseTime);
          envelope.gain.setValueAtTime(Math.max(0.0001, trackRef.params.sustain), releaseTime);
        }

        envelope.gain.setTargetAtTime(0.0001, releaseTime, releaseSeconds / 3);

        const stopAt = releaseTime + releaseSeconds * 1.6 + 0.08;
        osc1.stop(stopAt);
        osc2.stop(stopAt);
        modOsc.stop(stopAt);
      },
      setFrequency(nextFrequency, when = ctx.currentTime) {
        this.frequency = nextFrequency;
        osc1.frequency.setTargetAtTime(nextFrequency, when, 0.01);
        osc2.frequency.setTargetAtTime(nextFrequency, when, 0.01);
      },
      updateFromTrackParams(when = ctx.currentTime) {
        const hasOsc2 = trackRef.params.osc2Enabled;
        const mix = clamp(trackRef.params.oscMix, 0, 1);

        osc1.type = trackRef.params.waveform;
        osc2.type = trackRef.params.waveform;

        osc1.detune.setTargetAtTime(-trackRef.params.detune, when, 0.02);
        osc2.detune.setTargetAtTime(trackRef.params.detune, when, 0.02);

        mix1.gain.setTargetAtTime(hasOsc2 ? 1 - mix : 1, when, 0.02);
        mix2.gain.setTargetAtTime(hasOsc2 ? mix : 0, when, 0.02);

        dryGain.gain.setTargetAtTime(1 - trackRef.params.metallic, when, 0.03);
        ringWet.gain.setTargetAtTime(trackRef.params.metallic, when, 0.03);

        modOsc.frequency.setTargetAtTime(70 + trackRef.params.metallic * 980, when, 0.03);
        modDepth.gain.setTargetAtTime(0.35 + trackRef.params.metallic * 0.65, when, 0.03);
      },
      cleanup() {
        if (this.cleaned) {
          return;
        }

        this.cleaned = true;
        osc1.disconnect();
        osc2.disconnect();
        mix1.disconnect();
        mix2.disconnect();
        oscBus.disconnect();
        dryGain.disconnect();
        ringGain.disconnect();
        ringWet.disconnect();
        modOsc.disconnect();
        modDepth.disconnect();
        envelope.disconnect();

        trackRef.liveVoices.delete(this);
        if (trackRef.activeVoice === this) {
          trackRef.activeVoice = null;
        }
      },
    };

    voice.updateFromTrackParams(startTime);

    osc1.frequency.setValueAtTime(frequency, startTime);
    osc2.frequency.setValueAtTime(frequency, startTime);

    const attackEnd = startTime + Math.max(0.001, this.params.attack);
    const decayEnd = attackEnd + Math.max(0.001, this.params.decay);
    const sustainLevel = Math.max(0.0001, this.params.sustain);

    envelope.gain.cancelScheduledValues(startTime);
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.linearRampToValueAtTime(1, attackEnd);
    envelope.gain.linearRampToValueAtTime(sustainLevel, decayEnd);

    osc1.onended = () => voice.cleanup();
    osc2.onended = () => voice.cleanup();

    osc1.start(startTime);
    osc2.start(startTime);
    modOsc.start(startTime);

    this.liveVoices.add(voice);
    return voice;
  }

  noteOn(frequency, startTime = this.context.currentTime) {
    if (this.activeVoice) {
      this.activeVoice.releaseAt(startTime);
    }

    this.activeVoice = this.createVoice(frequency, startTime);
    return this.activeVoice;
  }

  updateNote(frequency, when = this.context.currentTime) {
    if (!this.activeVoice) {
      return;
    }

    this.activeVoice.setFrequency(frequency, when);
  }

  noteOff(releaseTime = this.context.currentTime) {
    if (!this.activeVoice) {
      return;
    }

    this.activeVoice.releaseAt(releaseTime);
  }

  triggerScheduled(frequency, startTime, duration) {
    const voice = this.createVoice(frequency, startTime);
    voice.releaseAt(startTime + Math.max(0.03, duration));
    return voice;
  }

  clearEvents() {
    this.events = [];
    this.recordingNote = null;
  }
}

class Recorder {
  constructor(context, stream) {
    this.context = context;
    this.stream = stream;
    this.state = "idle";
    this.mediaRecorder = null;
    this.chunks = [];
    this.onStateChange = () => {};
  }

  setState(state) {
    this.state = state;
    this.onStateChange(state);
  }

  start() {
    if (typeof window.MediaRecorder === "undefined") {
      console.warn("MediaRecorder is not available in this browser.");
      return false;
    }

    if (this.state !== "idle") {
      return false;
    }

    const preferredTypes = ["audio/wav", "audio/webm;codecs=opus", "audio/webm"];
    let mimeType = "";

    for (const candidate of preferredTypes) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        mimeType = candidate;
        break;
      }
    }

    try {
      this.mediaRecorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
    } catch (error) {
      console.error("Cannot start MediaRecorder:", error);
      return false;
    }

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.mediaRecorder.start(200);
    this.setState("recording");
    return true;
  }

  async stopAndDownload(baseFileName = "scaffold-synth-master") {
    if (!this.mediaRecorder || this.state !== "recording") {
      return;
    }

    this.setState("downloading");

    const blob = await new Promise((resolve) => {
      const recorder = this.mediaRecorder;
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });

    let outputBlob = blob;
    let extension = "wav";

    try {
      if (!blob.type.includes("wav")) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await this.context.decodeAudioData(arrayBuffer.slice(0));
        outputBlob = audioBufferToWavBlob(audioBuffer);
      }
    } catch (error) {
      console.warn("WAV conversion failed, downloading native blob format instead.", error);
      extension = blob.type.includes("ogg") ? "ogg" : "webm";
      outputBlob = blob;
    }

    this.triggerDownload(outputBlob, `${baseFileName}-${Date.now()}.${extension}`);
    this.setState("idle");
  }

  triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 2500);
  }
}

class AudioEngine {
  constructor() {
    this.initialized = false;

    this.context = null;
    this.masterInput = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.reverbInput = null;
    this.streamDestination = null;

    this.activeTrackIndex = 0;
    this.liveTrackIndex = null;
    this.tracks = [];

    this.pendingTrackParams = Array.from({ length: NUM_TRACKS }, () => ({ ...DEFAULT_TRACK_PARAMS }));
    this.pendingTrackEnabled = Array.from({ length: NUM_TRACKS }, () => true);
    this.pendingMasterVolume = 0.85;

    this.loopPlaying = false;
    this.loopLength = 4;
    this.loopStartTime = 0;
    this.nextCycleTime = 0;
    this.loopIntervalId = null;

    this.recorder = null;

    this.onEventsChanged = () => {};
    this.onLoopStateChange = () => {};
  }

  async init() {
    if (this.initialized) {
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextCtor();

    this.masterInput = this.context.createGain();
    this.masterGain = this.context.createGain();
    this.masterAnalyser = this.context.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.smoothingTimeConstant = 0.85;

    this.streamDestination = this.context.createMediaStreamDestination();

    const masterCompressor = this.context.createDynamicsCompressor();
    masterCompressor.threshold.value = -14;
    masterCompressor.ratio.value = 3;

    this.masterInput.connect(masterCompressor);
    masterCompressor.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.context.destination);
    this.masterAnalyser.connect(this.streamDestination);

    this.masterGain.gain.value = this.pendingMasterVolume;

    this.reverbInput = this.context.createGain();
    const convolver = this.context.createConvolver();
    convolver.buffer = createReverbImpulse(this.context);
    const reverbReturn = this.context.createGain();
    reverbReturn.gain.value = 0.42;

    this.reverbInput.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(this.masterInput);

    this.tracks = [];
    for (let i = 0; i < NUM_TRACKS; i += 1) {
      const track = new Track(this.context, i + 1, this.masterInput, this.reverbInput);

      for (const [key, value] of Object.entries(this.pendingTrackParams[i])) {
        track.setParam(key, value);
      }

      track.setEnabled(this.pendingTrackEnabled[i]);
      this.tracks.push(track);
    }

    this.recorder = new Recorder(this.context, this.streamDestination.stream);

    await this.context.resume();
    this.unlockContextForMobile();
    this.initialized = true;
  }

  unlockContextForMobile() {
    // iOS/Safari can keep contexts semi-suspended until the graph has emitted at least once.
    if (!this.context) {
      return;
    }

    try {
      const buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = 0;

      source.buffer = buffer;
      source.connect(gain);
      gain.connect(this.context.destination);
      source.start();
      source.stop(this.context.currentTime + 0.01);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
    } catch (error) {
      console.warn("Context mobile unlock failed:", error);
    }
  }

  ensureRunning() {
    if (!this.initialized) {
      return;
    }

    if (this.context.state === "suspended") {
      this.context.resume().then(() => this.unlockContextForMobile());
    }
  }

  setActiveTrack(index) {
    this.activeTrackIndex = clamp(index, 0, NUM_TRACKS - 1);
  }

  setMasterVolume(value) {
    this.pendingMasterVolume = value;
    if (!this.initialized) {
      return;
    }

    this.masterGain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }

  setTrackParam(trackIndex, param, value) {
    this.pendingTrackParams[trackIndex][param] = value;

    if (!this.initialized) {
      return;
    }

    this.tracks[trackIndex].setParam(param, value);
  }

  setTrackEnabled(trackIndex, enabled) {
    this.pendingTrackEnabled[trackIndex] = enabled;

    if (!this.initialized) {
      return;
    }

    this.tracks[trackIndex].setEnabled(enabled);
  }

  startLiveNote(frequency) {
    if (!this.initialized) {
      return;
    }

    this.ensureRunning();

    const track = this.tracks[this.activeTrackIndex];
    track.noteOn(frequency, this.context.currentTime);
    this.liveTrackIndex = this.activeTrackIndex;

    if (track.recordArmed) {
      const now = this.context.currentTime;
      track.recordingNote = {
        startTime: now,
        startPos: this.getRecordPosition(track, now),
        freq: frequency,
      };
    }
  }

  moveLiveNote(frequency) {
    if (!this.initialized || this.liveTrackIndex === null) {
      return;
    }

    const track = this.tracks[this.liveTrackIndex];
    track.updateNote(frequency, this.context.currentTime);

    if (track.recordArmed && track.recordingNote) {
      track.recordingNote.freq = frequency;
    }
  }

  endLiveNote() {
    if (!this.initialized || this.liveTrackIndex === null) {
      return;
    }

    const trackIndex = this.liveTrackIndex;
    const track = this.tracks[trackIndex];
    track.noteOff(this.context.currentTime);

    if (track.recordArmed && track.recordingNote) {
      this.commitRecordedNote(trackIndex, track.recordingNote, this.context.currentTime);
      track.recordingNote = null;
    }

    this.liveTrackIndex = null;
  }

  getRecordPosition(track, time) {
    if (this.loopPlaying) {
      let position = (time - this.loopStartTime) % this.loopLength;
      if (position < 0) {
        position += this.loopLength;
      }
      return position;
    }

    if (!Number.isFinite(track.recordBaseTime)) {
      track.recordBaseTime = time;
    }

    return Math.max(0, time - track.recordBaseTime);
  }

  commitRecordedNote(trackIndex, recordingNote, noteOffTime) {
    const track = this.tracks[trackIndex];
    const duration = Math.max(0.04, noteOffTime - recordingNote.startTime);

    if (this.loopPlaying) {
      const wrappedStart = ((recordingNote.startPos % this.loopLength) + this.loopLength) % this.loopLength;
      const clippedDuration = Math.min(duration, this.loopLength);
      const segmentOne = Math.min(clippedDuration, this.loopLength - wrappedStart);
      const segmentTwo = clippedDuration - segmentOne;

      track.events.push({
        time: wrappedStart,
        duration: segmentOne,
        freq: recordingNote.freq,
        track: track.id,
      });

      if (segmentTwo > 0.01) {
        track.events.push({
          time: 0,
          duration: segmentTwo,
          freq: recordingNote.freq,
          track: track.id,
        });
      }
    } else {
      track.events.push({
        time: Math.max(0, recordingNote.startPos),
        duration,
        freq: recordingNote.freq,
        track: track.id,
      });
    }

    track.events.sort((a, b) => a.time - b.time);
    this.onEventsChanged();
  }

  toggleRecordForTrack(trackIndex) {
    if (!this.initialized) {
      return false;
    }

    const targetTrack = this.tracks[trackIndex];
    const nextState = !targetTrack.recordArmed;

    for (const track of this.tracks) {
      track.recordArmed = false;
      track.recordingNote = null;
    }

    targetTrack.recordArmed = nextState;
    if (nextState && !this.loopPlaying) {
      targetTrack.recordBaseTime = this.context.currentTime;
    }

    return nextState;
  }

  getRecordStates() {
    if (!this.initialized) {
      return Array.from({ length: NUM_TRACKS }, () => false);
    }

    return this.tracks.map((track) => track.recordArmed);
  }

  calculateLoopLength() {
    let maxEnd = 0;
    for (const track of this.tracks) {
      for (const event of track.events) {
        maxEnd = Math.max(maxEnd, event.time + event.duration);
      }
    }

    return maxEnd > 0 ? Math.max(2, maxEnd) : 0;
  }

  scheduleCycle(cycleStartTime) {
    for (const track of this.tracks) {
      for (const event of track.events) {
        const startTime = cycleStartTime + clamp(event.time, 0, this.loopLength);
        track.triggerScheduled(event.freq, startTime, event.duration);
      }
    }
  }

  startLoop() {
    if (!this.initialized) {
      return false;
    }

    const hasEvents = this.tracks.some((track) => track.events.length > 0);
    if (!hasEvents) {
      return false;
    }

    this.ensureRunning();

    this.loopLength = this.calculateLoopLength();
    if (this.loopLength <= 0) {
      return false;
    }

    this.loopStartTime = this.context.currentTime + 0.08;
    this.nextCycleTime = this.loopStartTime;
    this.scheduleCycle(this.nextCycleTime);

    this.loopIntervalId = window.setInterval(() => {
      this.nextCycleTime += this.loopLength;
      this.scheduleCycle(this.nextCycleTime);
    }, this.loopLength * 1000);

    this.loopPlaying = true;
    this.onLoopStateChange(true);
    return true;
  }

  stopLoop() {
    if (this.loopIntervalId !== null) {
      window.clearInterval(this.loopIntervalId);
      this.loopIntervalId = null;
    }

    this.loopPlaying = false;
    this.onLoopStateChange(false);
  }

  toggleLoop() {
    if (!this.loopPlaying) {
      return this.startLoop();
    }

    this.stopLoop();
    return false;
  }

  restartLoopIfPlaying() {
    if (!this.loopPlaying) {
      return;
    }

    const hasEvents = this.tracks.some((track) => track.events.length > 0);
    this.stopLoop();
    if (hasEvents) {
      this.startLoop();
    }
  }

  clearTrack(trackIndex) {
    if (!this.initialized) {
      return;
    }

    this.tracks[trackIndex].clearEvents();
    this.onEventsChanged();
    this.restartLoopIfPlaying();
  }

  clearAll() {
    if (!this.initialized) {
      return;
    }

    for (const track of this.tracks) {
      track.clearEvents();
      track.recordArmed = false;
    }

    this.onEventsChanged();

    if (this.loopPlaying) {
      this.stopLoop();
    }
  }

  getEventsCountByTrack() {
    if (!this.initialized) {
      return Array.from({ length: NUM_TRACKS }, () => 0);
    }

    return this.tracks.map((track) => track.events.length);
  }

  getLoopLengthSeconds() {
    if (!this.initialized) {
      return 0;
    }

    return this.calculateLoopLength();
  }
}

class Visualizer {
  constructor(canvas, getEngine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.getEngine = getEngine;
    this.labels = ["MASTER", "TRACK 1", "TRACK 2", "TRACK 3", "TRACK 4"];
    this.colors = ["#1f8dff", ...TRACK_COLORS];
    this.buffers = new Map();
    this.rafId = null;
  }

  start() {
    if (this.rafId !== null) {
      return;
    }

    const renderFrame = () => {
      this.render();
      this.rafId = window.requestAnimationFrame(renderFrame);
    };

    renderFrame();
  }

  resizeCanvasToDisplaySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const displayWidth = Math.floor(this.canvas.clientWidth * dpr);
    const displayHeight = Math.floor(this.canvas.clientHeight * dpr);

    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth;
      this.canvas.height = displayHeight;
    }

    return { width: this.canvas.width, height: this.canvas.height, dpr };
  }

  getDataFromAnalyser(analyser) {
    if (!this.buffers.has(analyser)) {
      this.buffers.set(analyser, new Uint8Array(analyser.fftSize));
    }

    const buffer = this.buffers.get(analyser);
    analyser.getByteTimeDomainData(buffer);
    return buffer;
  }

  render() {
    const { width, height } = this.resizeCanvasToDisplaySize();
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
    ctx.fillRect(0, 0, width, height);

    const engine = this.getEngine();
    const analysers =
      engine && engine.initialized
        ? [engine.masterAnalyser, ...engine.tracks.map((track) => track.analyser)]
        : [];

    const rows = 5;
    const rowHeight = height / rows;

    for (let row = 0; row < rows; row += 1) {
      const yTop = row * rowHeight;
      const yMiddle = yTop + rowHeight / 2;

      ctx.strokeStyle = "rgba(15, 23, 34, 0.11)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yMiddle);
      ctx.lineTo(width, yMiddle);
      ctx.stroke();

      ctx.fillStyle = "rgba(57, 72, 92, 0.72)";
      ctx.font = `${Math.max(9, Math.floor(rowHeight * 0.19))}px Manrope`;
      ctx.fillText(this.labels[row], 8, yTop + Math.max(11, rowHeight * 0.23));

      if (row >= analysers.length) {
        continue;
      }

      const data = this.getDataFromAnalyser(analysers[row]);
      ctx.strokeStyle = this.colors[row];
      ctx.lineWidth = Math.max(1.2, rowHeight * 0.035);
      ctx.beginPath();

      const points = Math.min(data.length, width);
      for (let x = 0; x < width; x += 1) {
        const index = Math.floor((x / width) * points);
        const sample = data[index] / 255;
        const y = yTop + rowHeight * 0.14 + sample * rowHeight * 0.72;
        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
    }
  }
}

class ScaffoldController {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.gridX = 8;
    this.gridY = 5;
    this.spacing = 1.5;
    this.snapAmount = 0.85;

    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    this.camera.position.set(0, 2.8, 11);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();

    this.scaffoldGroup = new THREE.Group();
    this.scene.add(this.scaffoldGroup);

    this.points = [];
    this.grid = [];
    this.bars = [];

    this.hoveredPoint = null;
    this.visualEnergy = 0;
    this.scaffoldCenter = new THREE.Vector3();

    const ambient = new THREE.HemisphereLight(0xeef7ff, 0x9ba5b8, 0.95);
    this.scene.add(ambient);

    const key = new THREE.PointLight(0x7fc0ff, 1.2, 60);
    key.position.set(6, 5, 9);
    this.scene.add(key);

    this.interactionPlane = new THREE.Mesh(
      new THREE.PlaneGeometry((this.gridX - 1) * this.spacing + 8, (this.gridY - 1) * this.spacing + 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.interactionPlane.position.z = 0;
    this.scene.add(this.interactionPlane);

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 24, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x44a8ff,
        emissiveIntensity: 1.1,
        transparent: true,
        opacity: 0.95,
      })
    );
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.buildScaffold();
    this.fitCameraToScaffold();

    this.isPointerDown = false;
    this.activePointerId = null;

    this.handleResize = this.handleResize.bind(this);
    this.animate = this.animate.bind(this);

    this.bindPointerEvents();
    this.handleResize();

    window.addEventListener("resize", this.handleResize);
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.container);

    this.animate();
  }

  buildScaffold() {
    const totalPoints = this.gridX * this.gridY;
    const scaleMidis = generateMajorScaleMidis(totalPoints, 36);

    const baseBarColor = new THREE.Color(0x7a8da9);
    const pointMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x2b9fff,
      emissiveIntensity: 0.18,
      roughness: 0.15,
      metalness: 0.28,
    });

    let index = 0;
    for (let y = 0; y < this.gridY; y += 1) {
      const row = [];
      for (let x = 0; x < this.gridX; x += 1) {
        const px = (x - (this.gridX - 1) / 2) * this.spacing;
        const py = (y - (this.gridY - 1) / 2) * this.spacing;
        const pz = Math.sin(x * 0.8 + y * 0.55) * 0.32;

        const freq = midiToFrequency(scaleMidis[index]);
        const note = midiToNoteName(scaleMidis[index]);

        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.08, 18, 18), pointMaterial.clone());
        sphere.position.set(px, py, pz);

        this.scaffoldGroup.add(sphere);

        const point = {
          x,
          y,
          frequency: freq,
          note,
          position: sphere.position.clone(),
          mesh: sphere,
        };

        row.push(point);
        this.points.push(point);
        index += 1;
      }
      this.grid.push(row);
    }

    const addBar = (from, to, diagonal = false) => {
      const direction = new THREE.Vector3().subVectors(to.position, from.position);
      const length = direction.length();
      const geometry = new THREE.CylinderGeometry(0.017, 0.017, length, 8);
      const material = new THREE.MeshStandardMaterial({
        color: baseBarColor,
        emissive: 0x24578f,
        emissiveIntensity: 0.08,
        roughness: 0.3,
        metalness: 0.55,
        transparent: true,
        opacity: diagonal ? 0.23 : 0.33,
      });

      const mesh = new THREE.Mesh(geometry, material);
      const midpoint = new THREE.Vector3().addVectors(from.position, to.position).multiplyScalar(0.5);
      mesh.position.copy(midpoint);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
      mesh.userData.phase = Math.random() * Math.PI * 2;
      mesh.userData.baseOpacity = diagonal ? 0.23 : 0.33;

      this.scaffoldGroup.add(mesh);
      this.bars.push(mesh);
    };

    for (let y = 0; y < this.gridY; y += 1) {
      for (let x = 0; x < this.gridX; x += 1) {
        const point = this.grid[y][x];

        if (x < this.gridX - 1) {
          addBar(point, this.grid[y][x + 1], false);
        }

        if (y < this.gridY - 1) {
          addBar(point, this.grid[y + 1][x], false);
        }

        if (x < this.gridX - 1 && y < this.gridY - 1 && (x + y) % 2 === 0) {
          addBar(point, this.grid[y + 1][x + 1], true);
        }

        if (x > 0 && y < this.gridY - 1 && (x + y) % 2 !== 0) {
          addBar(point, this.grid[y + 1][x - 1], true);
        }
      }
    }
  }

  bindPointerEvents() {
    const dom = this.renderer.domElement;

    dom.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      const sample = this.sampleFromEvent(event);
      if (!sample) {
        return;
      }

      this.isPointerDown = true;
      this.activePointerId = event.pointerId;
      dom.setPointerCapture(event.pointerId);
      this.visualEnergy = 1;

      this.updateVisuals(sample);
      this.callbacks.onPreview(sample);
      this.callbacks.onNoteStart(sample);
    });

    dom.addEventListener("pointermove", (event) => {
      if (event.cancelable) {
        event.preventDefault();
      }

      if (this.isPointerDown && event.pointerId !== this.activePointerId) {
        return;
      }

      const sample = this.sampleFromEvent(event);
      if (!sample) {
        return;
      }

      this.updateVisuals(sample);
      this.callbacks.onPreview(sample);

      if (this.isPointerDown) {
        this.visualEnergy = 1;
        this.callbacks.onNoteMove(sample);
      }
    });

    const release = (event) => {
      if (!this.isPointerDown) {
        return;
      }

      if (event.pointerId !== this.activePointerId) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      this.isPointerDown = false;
      this.activePointerId = null;
      this.callbacks.onNoteEnd();
    };

    dom.addEventListener("pointerup", release);
    dom.addEventListener("pointercancel", release);
    dom.addEventListener("lostpointercapture", release);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);

    if (typeof window.PointerEvent === "undefined") {
      dom.addEventListener(
        "touchstart",
        (event) => {
          if (event.cancelable) {
            event.preventDefault();
          }

          const touch = event.touches[0];
          if (!touch) {
            return;
          }

          const sample = this.sampleFromClient(touch.clientX, touch.clientY);
          if (!sample) {
            return;
          }

          this.isPointerDown = true;
          this.visualEnergy = 1;
          this.updateVisuals(sample);
          this.callbacks.onPreview(sample);
          this.callbacks.onNoteStart(sample);
        },
        { passive: false }
      );

      dom.addEventListener(
        "touchmove",
        (event) => {
          if (event.cancelable) {
            event.preventDefault();
          }

          const touch = event.touches[0];
          if (!touch) {
            return;
          }

          const sample = this.sampleFromClient(touch.clientX, touch.clientY);
          if (!sample) {
            return;
          }

          this.updateVisuals(sample);
          this.callbacks.onPreview(sample);

          if (this.isPointerDown) {
            this.visualEnergy = 1;
            this.callbacks.onNoteMove(sample);
          }
        },
        { passive: false }
      );

      dom.addEventListener(
        "touchend",
        () => {
          if (!this.isPointerDown) {
            return;
          }

          this.isPointerDown = false;
          this.callbacks.onNoteEnd();
        },
        { passive: false }
      );
    }
  }

  sampleFromEvent(event) {
    return this.sampleFromClient(event.clientX, event.clientY);
  }

  sampleFromClient(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const normalizedX = clamp(localX / rect.width, 0, 1);
    const normalizedY = clamp(localY / rect.height, 0, 1);

    this.pointer.x = normalizedX * 2 - 1;
    this.pointer.y = -normalizedY * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObject(this.interactionPlane);
    if (!hits.length) {
      const gx = normalizedX * (this.gridX - 1);
      const gy = (1 - normalizedY) * (this.gridY - 1);
      return this.computeFrequencySampleFromGrid(gx, gy);
    }

    return this.computeFrequencySample(hits[0].point);
  }

  computeFrequencySample(point) {
    const halfX = (this.gridX - 1) / 2;
    const halfY = (this.gridY - 1) / 2;

    const gx = clamp(point.x / this.spacing + halfX, 0, this.gridX - 1);
    const gy = clamp(point.y / this.spacing + halfY, 0, this.gridY - 1);
    return this.computeFrequencySampleFromGrid(gx, gy);
  }

  computeFrequencySampleFromGrid(gx, gy) {
    const halfX = (this.gridX - 1) / 2;
    const halfY = (this.gridY - 1) / 2;

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(this.gridX - 1, x0 + 1);
    const y1 = Math.min(this.gridY - 1, y0 + 1);

    const tx = gx - x0;
    const ty = gy - y0;

    const f00 = this.grid[y0][x0].frequency;
    const f10 = this.grid[y0][x1].frequency;
    const f01 = this.grid[y1][x0].frequency;
    const f11 = this.grid[y1][x1].frequency;

    const fx0 = lerp(f00, f10, tx);
    const fx1 = lerp(f01, f11, tx);
    const interpolated = lerp(fx0, fx1, ty);

    const nearestX = Math.round(gx);
    const nearestY = Math.round(gy);
    const nearestPoint = this.grid[nearestY][nearestX];

    const distanceToPoint = Math.hypot(gx - nearestX, gy - nearestY);
    const rawSnap = clamp(1 - distanceToPoint / 0.85, 0, 1);
    const snapWeight = rawSnap * rawSnap * this.snapAmount;

    const frequency = lerp(interpolated, nearestPoint.frequency, snapWeight);
    const note = midiToNoteName(frequencyToMidi(frequency));

    return {
      frequency,
      note,
      nearestPoint,
      gridX: gx,
      gridY: gy,
      markerPosition: new THREE.Vector3(
        (gx - halfX) * this.spacing,
        (gy - halfY) * this.spacing,
        0.45
      ),
    };
  }

  updateVisuals(sample) {
    this.marker.visible = true;
    this.marker.position.copy(sample.markerPosition);

    if (this.hoveredPoint !== sample.nearestPoint) {
      if (this.hoveredPoint) {
        this.hoveredPoint.mesh.material.emissiveIntensity = 0.18;
        this.hoveredPoint.mesh.scale.setScalar(1);
      }

      this.hoveredPoint = sample.nearestPoint;
      this.hoveredPoint.mesh.material.emissiveIntensity = 0.95;
      this.hoveredPoint.mesh.scale.setScalar(1.28);
    }
  }

  handleResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) {
      return;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.fitCameraToScaffold();
  }

  fitCameraToScaffold() {
    const bounds = new THREE.Box3().setFromObject(this.scaffoldGroup);
    if (bounds.isEmpty()) {
      return;
    }

    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    this.scaffoldCenter.copy(center);

    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);

    // Tighter fit so the scaffold appears larger while keeping full note range visible.
    const fitPadding = 1.06;
    const distanceForHeight = ((size.y / 2) * fitPadding) / Math.tan(verticalFov / 2);
    const distanceForWidth = ((size.x / 2) * fitPadding) / Math.tan(horizontalFov / 2);
    const distance = Math.max(distanceForHeight, distanceForWidth) + 0.9;

    this.camera.position.set(center.x, center.y + size.y * 0.18, center.z + distance);
    this.camera.lookAt(this.scaffoldCenter);
  }

  animate() {
    const t = this.clock.getElapsedTime();
    this.visualEnergy = Math.max(0, this.visualEnergy * 0.96 - 0.001);

    for (const bar of this.bars) {
      const pulse = Math.sin(t * 2 + bar.userData.phase) * 0.05;
      bar.material.opacity = clamp(bar.userData.baseOpacity + pulse + this.visualEnergy * 0.26, 0.08, 0.92);
      bar.material.emissiveIntensity = 0.08 + this.visualEnergy * 0.72;
    }

    if (this.marker.visible) {
      const markerPulse = 1 + Math.sin(t * 6.2) * 0.12;
      this.marker.scale.setScalar(markerPulse);
    }

    this.renderer.render(this.scene, this.camera);
    window.requestAnimationFrame(this.animate);
  }
}

class UIController {
  constructor() {
    this.engine = new AudioEngine();

    this.activeTrackIndex = 0;
    this.trackParams = Array.from({ length: NUM_TRACKS }, () => ({ ...DEFAULT_TRACK_PARAMS }));
    this.trackMuted = Array.from({ length: NUM_TRACKS }, () => false);

    this.elements = {
      initOverlay: document.getElementById("init-overlay"),
      initButton: document.getElementById("init-audio-btn"),
      trackList: document.getElementById("track-list"),
      trackSelector: document.getElementById("track-selector"),
      hoverNote: document.getElementById("hover-note"),
      hoverFreq: document.getElementById("hover-freq"),
      currentNoteLabel: document.getElementById("current-note-label"),
      currentFreqLabel: document.getElementById("current-freq-label"),
      activeTrackLabel: document.getElementById("active-track-label"),
      recordStatePill: document.getElementById("record-state-pill"),
      masterRecordLabel: document.getElementById("master-record-label"),
      trackVolume: document.getElementById("track-volume"),
      masterVolume: document.getElementById("master-volume"),
      pan: document.getElementById("pan"),
      oscMix: document.getElementById("osc-mix"),
      detune: document.getElementById("detune"),
      attack: document.getElementById("attack"),
      decay: document.getElementById("decay"),
      sustain: document.getElementById("sustain"),
      release: document.getElementById("release"),
      filterCutoff: document.getElementById("filter-cutoff"),
      filterResonance: document.getElementById("filter-resonance"),
      reverb: document.getElementById("reverb"),
      distortion: document.getElementById("distortion"),
      phaser: document.getElementById("phaser"),
      metallic: document.getElementById("metallic"),
      crystalizer: document.getElementById("crystalizer"),
      waveform: document.getElementById("waveform"),
      filterType: document.getElementById("filter-type"),
      osc2Toggle: document.getElementById("osc2-toggle"),
      recordTrackBtn: document.getElementById("record-track-btn"),
      playLoopBtn: document.getElementById("play-loop-btn"),
      clearTrackBtn: document.getElementById("clear-track-btn"),
      clearAllBtn: document.getElementById("clear-all-btn"),
      recordMasterBtn: document.getElementById("record-master-btn"),
      scaffoldContainer: document.getElementById("scaffold-container"),
      scopeCanvas: document.getElementById("scope-canvas"),
      scopePanel: document.getElementById("scope-panel"),
      scopeToggleBtn: document.getElementById("scope-toggle-btn"),
      scopeReopenBtn: document.getElementById("scope-reopen-btn"),
    };

    this.trackCards = [];
    this.trackMiniVolumeInputs = [];
    this.trackMiniPanInputs = [];
    this.trackMetaLabels = [];
    this.trackMuteButtons = [];
    this.trackChips = [];

    this.visualizer = new Visualizer(this.elements.scopeCanvas, () => this.engine);
    this.visualizer.start();

    this.createTrackUI();
    this.bindControls();
    this.refreshSliderOutputs();
    this.setScopeCollapsed(false);
    this.setActiveTrack(0);

    this.scaffold = new ScaffoldController(this.elements.scaffoldContainer, {
      onPreview: (sample) => this.onScaffoldPreview(sample),
      onNoteStart: (sample) => this.onScaffoldNoteStart(sample),
      onNoteMove: (sample) => this.onScaffoldNoteMove(sample),
      onNoteEnd: () => this.onScaffoldNoteEnd(),
    });
  }

  createTrackUI() {
    for (let i = 0; i < NUM_TRACKS; i += 1) {
      const card = document.createElement("article");
      card.className = "track-card";
      card.dataset.trackIndex = String(i);

      const top = document.createElement("div");
      top.className = "track-top";

      const left = document.createElement("div");
      const name = document.createElement("div");
      name.className = "track-name";
      name.textContent = `Track ${i + 1}`;
      const meta = document.createElement("div");
      meta.className = "track-meta";
      meta.textContent = "0 events";
      left.append(name, meta);
      this.trackMetaLabels.push(meta);

      const buttons = document.createElement("div");
      buttons.className = "track-buttons";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "small-btn";
      selectBtn.textContent = "Select";
      selectBtn.addEventListener("click", () => this.setActiveTrack(i));

      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "small-btn";
      muteBtn.textContent = "Mute";
      muteBtn.addEventListener("click", () => {
        this.trackMuted[i] = !this.trackMuted[i];
        if (this.engine.initialized) {
          this.engine.setTrackEnabled(i, !this.trackMuted[i]);
        }
        this.refreshTrackUI();
      });
      this.trackMuteButtons.push(muteBtn);

      buttons.append(selectBtn, muteBtn);
      top.append(left, buttons);

      const volWrap = document.createElement("div");
      volWrap.className = "track-mini-slider";
      const volLabel = document.createElement("label");
      const volText = document.createElement("span");
      volText.textContent = "Vol";
      const volValue = document.createElement("output");
      volValue.textContent = "75%";
      volLabel.append(volText, volValue);

      const volInput = document.createElement("input");
      volInput.type = "range";
      volInput.min = "0";
      volInput.max = "1";
      volInput.step = "0.01";
      volInput.value = String(DEFAULT_TRACK_PARAMS.volume);
      volInput.addEventListener("input", () => {
        const value = Number(volInput.value);
        this.trackParams[i].volume = value;
        volValue.textContent = `${Math.round(value * 100)}%`;

        if (this.engine.initialized) {
          this.engine.setTrackParam(i, "volume", value);
        }

        if (this.activeTrackIndex === i) {
          this.elements.trackVolume.value = String(value);
          this.updateOutputForInput(this.elements.trackVolume);
        }
      });

      this.trackMiniVolumeInputs.push(volInput);
      volWrap.append(volLabel, volInput);

      const panWrap = document.createElement("div");
      panWrap.className = "track-mini-slider";
      const panLabel = document.createElement("label");
      const panText = document.createElement("span");
      panText.textContent = "Pan";
      const panValue = document.createElement("output");
      panValue.textContent = "C";
      panLabel.append(panText, panValue);

      const panInput = document.createElement("input");
      panInput.type = "range";
      panInput.min = "-1";
      panInput.max = "1";
      panInput.step = "0.01";
      panInput.value = "0";
      panInput.addEventListener("input", () => {
        const value = Number(panInput.value);
        this.trackParams[i].pan = value;
        panValue.textContent = this.formatValue(value, "pan");

        if (this.engine.initialized) {
          this.engine.setTrackParam(i, "pan", value);
        }

        if (this.activeTrackIndex === i) {
          this.elements.pan.value = String(value);
          this.updateOutputForInput(this.elements.pan);
        }
      });

      this.trackMiniPanInputs.push(panInput);
      panWrap.append(panLabel, panInput);

      card.append(top, volWrap, panWrap);
      this.elements.trackList.append(card);
      this.trackCards.push(card);

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "track-chip";
      chip.textContent = `Track ${i + 1}`;
      chip.addEventListener("click", () => this.setActiveTrack(i));
      this.elements.trackSelector.append(chip);
      this.trackChips.push(chip);
    }
  }

  bindControls() {
    this.elements.initButton.addEventListener("click", () => this.initializeAudio());
    this.elements.scopeToggleBtn.addEventListener("click", () => {
      const collapsed = this.elements.scopePanel.classList.contains("is-collapsed");
      this.setScopeCollapsed(!collapsed);
    });
    this.elements.scopeReopenBtn.addEventListener("click", () => {
      this.setScopeCollapsed(false);
    });

    const sliderBindings = [
      [this.elements.trackVolume, "volume"],
      [this.elements.pan, "pan"],
      [this.elements.oscMix, "oscMix"],
      [this.elements.detune, "detune"],
      [this.elements.attack, "attack"],
      [this.elements.decay, "decay"],
      [this.elements.sustain, "sustain"],
      [this.elements.release, "release"],
      [this.elements.filterCutoff, "filterCutoff"],
      [this.elements.filterResonance, "filterResonance"],
      [this.elements.reverb, "reverb"],
      [this.elements.distortion, "distortion"],
      [this.elements.phaser, "phaser"],
      [this.elements.metallic, "metallic"],
      [this.elements.crystalizer, "crystalizer"],
    ];

    for (const [input, param] of sliderBindings) {
      input.addEventListener("input", () => {
        const value = Number(input.value);
        this.trackParams[this.activeTrackIndex][param] = value;
        this.updateOutputForInput(input);

        if (this.engine.initialized) {
          this.engine.setTrackParam(this.activeTrackIndex, param, value);
        }

        if (param === "volume") {
          this.trackMiniVolumeInputs[this.activeTrackIndex].value = String(value);
          const output = this.trackMiniVolumeInputs[this.activeTrackIndex].previousElementSibling?.querySelector("output");
          if (output) {
            output.textContent = `${Math.round(value * 100)}%`;
          }
        }

        if (param === "pan") {
          this.trackMiniPanInputs[this.activeTrackIndex].value = String(value);
          const output = this.trackMiniPanInputs[this.activeTrackIndex].previousElementSibling?.querySelector("output");
          if (output) {
            output.textContent = this.formatValue(value, "pan");
          }
        }
      });
    }

    this.elements.masterVolume.addEventListener("input", () => {
      this.updateOutputForInput(this.elements.masterVolume);
      if (this.engine.initialized) {
        this.engine.setMasterVolume(Number(this.elements.masterVolume.value));
      }
    });

    this.elements.waveform.addEventListener("change", () => {
      const value = this.elements.waveform.value;
      this.trackParams[this.activeTrackIndex].waveform = value;
      if (this.engine.initialized) {
        this.engine.setTrackParam(this.activeTrackIndex, "waveform", value);
      }
    });

    this.elements.filterType.addEventListener("change", () => {
      const value = this.elements.filterType.value;
      this.trackParams[this.activeTrackIndex].filterType = value;
      if (this.engine.initialized) {
        this.engine.setTrackParam(this.activeTrackIndex, "filterType", value);
      }
    });

    this.elements.osc2Toggle.addEventListener("click", () => {
      const next = !this.trackParams[this.activeTrackIndex].osc2Enabled;
      this.trackParams[this.activeTrackIndex].osc2Enabled = next;
      this.applyOsc2ToggleState(next);

      if (this.engine.initialized) {
        this.engine.setTrackParam(this.activeTrackIndex, "osc2Enabled", next);
      }
    });

    this.elements.recordTrackBtn.addEventListener("click", () => {
      if (!this.engine.initialized) {
        return;
      }

      this.engine.toggleRecordForTrack(this.activeTrackIndex);
      this.syncRecordUI();
    });

    this.elements.playLoopBtn.addEventListener("click", () => {
      if (!this.engine.initialized) {
        return;
      }

      this.engine.toggleLoop();
      this.syncLoopUI();
    });

    this.elements.clearTrackBtn.addEventListener("click", () => {
      if (!this.engine.initialized) {
        return;
      }

      this.engine.clearTrack(this.activeTrackIndex);
      this.refreshEventCounters();
      this.syncRecordUI();
      this.syncLoopUI();
    });

    this.elements.clearAllBtn.addEventListener("click", () => {
      if (!this.engine.initialized) {
        return;
      }

      this.engine.clearAll();
      this.refreshEventCounters();
      this.syncRecordUI();
      this.syncLoopUI();
    });

    this.elements.recordMasterBtn.addEventListener("click", async () => {
      if (!this.engine.initialized || !this.engine.recorder) {
        return;
      }

      if (this.engine.recorder.state === "idle") {
        this.engine.recorder.start();
        return;
      }

      if (this.engine.recorder.state === "recording") {
        await this.engine.recorder.stopAndDownload();
      }
    });
  }

  async initializeAudio() {
    if (this.engine.initialized) {
      return;
    }

    try {
      await this.engine.init();

      this.engine.setMasterVolume(Number(this.elements.masterVolume.value));

      for (let i = 0; i < NUM_TRACKS; i += 1) {
        for (const [param, value] of Object.entries(this.trackParams[i])) {
          this.engine.setTrackParam(i, param, value);
        }
        this.engine.setTrackEnabled(i, !this.trackMuted[i]);
      }

      this.engine.setActiveTrack(this.activeTrackIndex);

      this.engine.onEventsChanged = () => {
        this.refreshEventCounters();
      };

      this.engine.onLoopStateChange = () => {
        this.syncLoopUI();
      };

      this.engine.recorder.onStateChange = (state) => {
        this.applyMasterRecorderState(state);
      };

      this.elements.initOverlay.classList.add("hidden");
      this.refreshEventCounters();
      this.syncRecordUI();
      this.syncLoopUI();
    } catch (error) {
      console.error("Audio initialization failed:", error);
      this.elements.initButton.textContent = "Initialization failed";
    }
  }

  setActiveTrack(index) {
    this.activeTrackIndex = index;
    this.elements.activeTrackLabel.textContent = String(index + 1);

    this.loadTrackParamsToControls(index);
    this.refreshTrackUI();

    if (this.engine.initialized) {
      this.engine.setActiveTrack(index);
      this.syncRecordUI();
    }
  }

  loadTrackParamsToControls(index) {
    const params = this.trackParams[index];

    this.elements.trackVolume.value = String(params.volume);
    this.elements.pan.value = String(params.pan);
    this.elements.oscMix.value = String(params.oscMix);
    this.elements.detune.value = String(params.detune);
    this.elements.attack.value = String(params.attack);
    this.elements.decay.value = String(params.decay);
    this.elements.sustain.value = String(params.sustain);
    this.elements.release.value = String(params.release);
    this.elements.filterCutoff.value = String(params.filterCutoff);
    this.elements.filterResonance.value = String(params.filterResonance);
    this.elements.reverb.value = String(params.reverb);
    this.elements.distortion.value = String(params.distortion);
    this.elements.phaser.value = String(params.phaser);
    this.elements.metallic.value = String(params.metallic);
    this.elements.crystalizer.value = String(params.crystalizer);

    this.elements.waveform.value = params.waveform;
    this.elements.filterType.value = params.filterType;

    this.applyOsc2ToggleState(params.osc2Enabled);
    this.refreshSliderOutputs();
  }

  refreshTrackUI() {
    for (let i = 0; i < NUM_TRACKS; i += 1) {
      const active = i === this.activeTrackIndex;
      this.trackCards[i].classList.toggle("is-active", active);
      this.trackChips[i].classList.toggle("is-active", active);

      const muted = this.trackMuted[i];
      this.trackMuteButtons[i].textContent = muted ? "Muted" : "Mute";
      this.trackMuteButtons[i].classList.toggle("is-muted", muted);
    }
  }

  refreshEventCounters() {
    const counts = this.engine.getEventsCountByTrack();
    for (let i = 0; i < NUM_TRACKS; i += 1) {
      const count = counts[i];
      const loopDuration = this.engine.getLoopLengthSeconds();
      const durationText = count > 0 ? ` · ${loopDuration.toFixed(2)}s` : "";
      this.trackMetaLabels[i].textContent = `${count} event${count === 1 ? "" : "s"}${durationText}`;
    }
  }

  syncLoopUI() {
    const playing = this.engine.loopPlaying;
    this.elements.playLoopBtn.classList.toggle("is-active", playing);
    this.elements.playLoopBtn.textContent = playing ? "Stop Loop" : "Play Loop";
  }

  syncRecordUI() {
    const states = this.engine.getRecordStates();

    for (let i = 0; i < NUM_TRACKS; i += 1) {
      this.trackChips[i].classList.toggle("is-recording", states[i]);
    }

    const activeArmed = states[this.activeTrackIndex];
    this.elements.recordTrackBtn.classList.toggle("is-active", activeArmed);
    this.elements.recordTrackBtn.textContent = activeArmed
      ? `Recording Track ${this.activeTrackIndex + 1}`
      : "Record Track";
  }

  setScopeCollapsed(collapsed) {
    this.elements.scopePanel.classList.toggle("is-collapsed", collapsed);
    this.elements.scopeToggleBtn.setAttribute("aria-expanded", String(!collapsed));
    this.elements.scopeToggleBtn.textContent = "Hide";

    if (collapsed) {
      this.elements.scopeReopenBtn.hidden = false;
      this.elements.scopeReopenBtn.classList.add("is-visible");
      return;
    }

    this.elements.scopeReopenBtn.classList.remove("is-visible");
    this.elements.scopeReopenBtn.hidden = true;
  }

  applyMasterRecorderState(state) {
    const btn = this.elements.recordMasterBtn;
    const pill = this.elements.recordStatePill;

    pill.classList.remove("is-recording", "is-downloading");
    btn.classList.remove("recording", "downloading");

    if (state === "recording") {
      this.elements.masterRecordLabel.textContent = "Recording";
      btn.textContent = "Stop Master";
      btn.classList.add("recording");
      pill.classList.add("is-recording");
      return;
    }

    if (state === "downloading") {
      this.elements.masterRecordLabel.textContent = "Downloading";
      btn.textContent = "Downloading...";
      btn.classList.add("downloading");
      pill.classList.add("is-downloading");
      return;
    }

    this.elements.masterRecordLabel.textContent = "Idle";
    btn.textContent = "Record Master";
  }

  applyOsc2ToggleState(enabled) {
    this.elements.osc2Toggle.setAttribute("aria-pressed", String(enabled));
    this.elements.osc2Toggle.classList.toggle("is-on", enabled);
    this.elements.osc2Toggle.textContent = enabled ? "On" : "Off";
  }

  refreshSliderOutputs() {
    const allInputs = document.querySelectorAll('input[type="range"]');
    for (const input of allInputs) {
      this.updateOutputForInput(input);
    }
  }

  updateOutputForInput(input) {
    const output = document.getElementById(`${input.id}-val`);
    if (!output) {
      return;
    }

    const value = Number(input.value);
    output.textContent = this.formatValue(value, input.dataset.format);
  }

  formatValue(value, format = "") {
    switch (format) {
      case "percent":
        return `${Math.round(value * 100)}%`;
      case "pan": {
        if (Math.abs(value) < 0.01) {
          return "C";
        }
        const side = value < 0 ? "L" : "R";
        return `${side}${Math.round(Math.abs(value) * 100)}`;
      }
      case "seconds":
        return `${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}s`;
      case "hz":
        return value >= 1000 ? `${(value / 1000).toFixed(2)}k` : `${Math.round(value)}`;
      case "cents":
        return `${Math.round(value)}c`;
      case "q":
        return value.toFixed(1);
      default:
        return value.toFixed(2);
    }
  }

  onScaffoldPreview(sample) {
    this.elements.hoverNote.textContent = `Note: ${sample.note}`;
    this.elements.hoverFreq.textContent = `${sample.frequency.toFixed(2)} Hz`;
    this.elements.currentNoteLabel.textContent = sample.note;
    this.elements.currentFreqLabel.textContent = `${sample.frequency.toFixed(2)} Hz`;
  }

  onScaffoldNoteStart(sample) {
    if (!this.engine.initialized) {
      return;
    }

    this.engine.startLiveNote(sample.frequency);
  }

  onScaffoldNoteMove(sample) {
    if (!this.engine.initialized) {
      return;
    }

    this.engine.moveLiveNote(sample.frequency);
  }

  onScaffoldNoteEnd() {
    if (!this.engine.initialized) {
      return;
    }

    this.engine.endLiveNote();
    this.refreshEventCounters();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new UIController();
});
