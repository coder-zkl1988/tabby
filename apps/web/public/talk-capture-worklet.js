// Microphone capture for realtime Talk.
//
// Runs on the audio thread and hands raw Float32 frames to the main thread,
// which converts them to PCM16 and ships them to the controller. Kept this
// thin deliberately: the AudioContext is created at the session's own sample
// rate, so there is no resampling to do here, and doing base64 work on the
// audio thread would risk glitching capture.

class TalkCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // `channel` is reused between renders, so post a copy.
      this.port.postMessage(channel.slice(0));
    }
    // Keep the node alive even while the mic is momentarily silent.
    return true;
  }
}

registerProcessor("talk-capture", TalkCaptureProcessor);
