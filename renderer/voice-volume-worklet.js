import { PeakLimiter } from './voice-limiter.js';

class VoiceVolumeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gain', defaultValue: 1, minValue: 0, maxValue: 10 ** (18 / 20), automationRate: 'a-rate' }];
  }

  constructor() {
    super();
    this.limiter = new PeakLimiter(sampleRate, 2);
    this.port.onmessage = ({ data }) => { if (data === 'reset') this.limiter.reset(); };
  }

  process(inputs, outputs, parameters) {
    this.limiter.process(inputs[0] ?? [], outputs[0], parameters.gain);
    return true;
  }
}

registerProcessor('voice-volume', VoiceVolumeProcessor);
