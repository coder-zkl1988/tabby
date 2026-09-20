// Microphone capture for realtime Talk.
//
// Runs on the audio thread and hands raw Float32 frames to the main thread,
// which converts them to PCM16 and ships them to the controller. Kept this
// thin deliberately: the AudioContext is created at the session's own sample
// rate, so there is no resampling to do here, and doing base64 work on the
// audio thread would risk glitching capture.
//
// Frames are batched to 20 ms before they leave this thread. A render quantum
// is fixed at 128 samples — ~5.3 ms at 24 kHz, so ~188 messages a second — and
// each one becomes its own WebSocket frame and its own Gateway JSON-RPC (with a
// uuid, a timeout timer and two log lines) downstream. Batching here cuts that
// to 50/s at the source, well inside what server VAD tolerates.

const FRAME_MS = 20;

class TalkCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(
      Math.max(128, Math.round((sampleRate * FRAME_MS) / 1000)),
    );
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      let offset = 0;
      while (offset < channel.length) {
        const take = Math.min(
          this.frame.length - this.filled,
          channel.length - offset,
        );
        this.frame.set(channel.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled === this.frame.length) {
          // `frame` is reused between renders, so post a copy.
          this.port.postMessage(this.frame.slice(0));
          this.filled = 0;
        }
      }
    }
    // Keep the node alive even while the mic is momentarily silent.
    return true;
  }
}

registerProcessor("talk-capture", TalkCaptureProcessor);
