class PCMMixProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frameSize = input[0].length;
    const mixed = new Float32Array(frameSize);

    // Mixage mono: on moyenne toutes les voies disponibles pour limiter la saturation.
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channel = input[channelIndex];
      for (let i = 0; i < frameSize; i += 1) {
        mixed[i] += channel[i] / channels;
      }
    }

    this.port.postMessage(mixed, [mixed.buffer]);
    return true;
  }
}

registerProcessor('pcm-mix-processor', PCMMixProcessor);
