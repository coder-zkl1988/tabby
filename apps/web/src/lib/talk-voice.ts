/**
 * Realtime voice session: microphone in, assistant audio out.
 *
 * Transport is one WebSocket to the controller, which relays to the OpenClaw
 * Gateway (`talk.session.appendAudio` up, `talk.event` down). Binary frames are
 * PCM16 audio; text frames are control messages.
 *
 * Two things here are not obvious and were established against a live StepFun
 * session:
 *
 *  - Capture must keep streaming while the user is silent. Server VAD decides a
 *    turn ended by *hearing* silence; if the client stops sending when the user
 *    stops talking, the turn never closes and no reply is ever generated.
 *  - Playback is scheduled on a running cursor rather than fired per chunk,
 *    otherwise consecutive deltas overlap and the voice sounds doubled.
 */

const DEFAULT_SAMPLE_RATE_HZ = 24000;

export type TalkStatus =
  | "idle"
  | "starting"
  | "listening"
  | "speaking"
  | "error";

export interface TalkSessionCallbacks {
  onStatus?: (status: TalkStatus) => void;
  onTranscript?: (text: string, role: "user" | "assistant") => void;
  onError?: (message: string) => void;
}

interface TalkSessionInit {
  sessionId: string;
  inputSampleRateHz?: number;
  outputSampleRateHz?: number;
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

// The explicit `Float32Array<ArrayBuffer>` matters: TS 5.7 made typed arrays
// generic over their backing buffer, and `copyToChannel` refuses the default
// `ArrayBufferLike` because that admits SharedArrayBuffer.
function pcm16ToFloat(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  // A chunk that decodes to an odd byte count makes the Int16Array constructor
  // throw ("byte length ... should be a multiple of 2"); drop the stray byte.
  const usable = buffer.byteLength - (buffer.byteLength % 2);
  const view = new Int16Array(buffer, 0, usable / 2);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) {
    out[i] = (view[i] ?? 0) / 0x8000;
  }
  return out;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pull audio + transcript out of a `talk.event` envelope.
 *
 * The Gateway nests these differently depending on the emitter, so probe a few
 * shapes instead of pinning one: a missed match is a silent assistant.
 */
export function extractTalkAudio(payload: unknown): {
  audioBase64?: string;
  turnId?: string;
  transcript?: { text: string; role: "user" | "assistant"; final: boolean };
} {
  if (typeof payload !== "object" || payload === null) return {};
  const record = asRecord(payload);
  const event = asRecord(record.talkEvent ?? record);
  const inner = asRecord(event.payload ?? event);

  const type = typeof event.type === "string" ? event.type : "";
  // `delta` carries base64 audio on audio events but plain *text* on transcript
  // events. Probing it blind fed sentences to `atob`, which throws on the first
  // space; `audio` is unambiguous, `delta` is only trusted otherwise.
  // OpenClaw 9.4 keeps the PCM on the outer relay envelope; its nested
  // `output.audio.delta` event only contains byte-length metadata.
  const audioBase64 = [
    inner.audioBase64,
    event.audioBase64,
    record.audioBase64,
    inner.audio,
    event.audio,
    record.audio,
    ...(/transcript|text/i.test(type) ? [] : [inner.delta]),
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const turnId = [inner.turnId, event.turnId, record.turnId].find(
    (value): value is string => typeof value === "string",
  );

  const text = [
    inner.transcript,
    inner.text,
    event.transcript,
    event.text,
    record.transcript,
    record.text,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const role = [inner.role, event.role, record.role].find(
    (value): value is "user" | "assistant" =>
      value === "user" || value === "assistant",
  );
  const final = [event.final, inner.final, record.final].find(
    (value): value is boolean => typeof value === "boolean",
  );
  const transcript =
    text === undefined
      ? undefined
      : {
          text,
          role:
            role ??
            (/input|user/i.test(type)
              ? ("user" as const)
              : ("assistant" as const)),
          final: final ?? !/delta|partial/i.test(type),
        };

  return { audioBase64, turnId, transcript };
}

export class TalkVoiceSession {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private playbackCursor = 0;
  private scheduled = new Set<AudioBufferSourceNode>();
  private playbackMarks = new Map<string, Set<AudioBufferSourceNode>>();
  private currentTurnId: string | undefined;
  private outputRate = DEFAULT_SAMPLE_RATE_HZ;
  private disposed = false;

  constructor(private readonly callbacks: TalkSessionCallbacks = {}) {}

  async start(init: TalkSessionInit): Promise<void> {
    this.callbacks.onStatus?.("starting");
    const inputRate = init.inputSampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.outputRate = init.outputSampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;

    // Asking the AudioContext for the session's rate avoids resampling by hand;
    // browsers honour this for capture graphs.
    const context = new AudioContext({ sampleRate: inputRate });
    this.context = context;
    await context.audioWorklet.addModule("/talk-capture-worklet.js");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.disposed) {
      // `stop()` ran while the permission prompt was up, so it saw no stream to
      // release. Assigning this one now would leave the microphone hot for the
      // life of the page with nothing left to turn it off.
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => {});
      return;
    }
    this.stream = stream;

    const socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}/api/v1/talk/stream?sessionId=${encodeURIComponent(init.sessionId)}`,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => this.handleDownstream(event.data);
    socket.onerror = () => {
      // A socket we closed ourselves can still emit `error` on some browsers.
      if (!this.disposed) this.fail("voice stream failed");
    };
    socket.onclose = () => {
      if (!this.disposed) void this.stop();
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.addEventListener("error", () =>
        reject(new Error("voice stream failed to open")),
      );
      socket.addEventListener("close", () =>
        reject(new Error("voice stream closed before opening")),
      );
    });
    if (this.disposed) return;

    const source = context.createMediaStreamSource(this.stream);
    const worklet = new AudioWorkletNode(context, "talk-capture");
    this.worklet = worklet;
    worklet.port.onmessage = (event) => {
      const frame = event.data as Float32Array;
      if (socket.readyState !== WebSocket.OPEN) return;
      // Sent unconditionally, including silence — see the file header.
      socket.send(floatToPcm16(frame));
    };
    source.connect(worklet);
    // The worklet emits no output; connecting it to the destination keeps some
    // browsers from garbage-collecting the graph.
    worklet.connect(context.destination);

    this.callbacks.onStatus?.("listening");
  }

  private handleDownstream(data: unknown): void {
    if (this.disposed || typeof data !== "string") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const record = asRecord(payload);
    if (record.type === "error") {
      this.fail(
        typeof record.message === "string"
          ? record.message
          : "voice session failed",
      );
      return;
    }
    if (record.type === "close") {
      void this.stop();
      return;
    }
    if (record.type === "clear") {
      this.clearPlayback();
      this.callbacks.onStatus?.("listening");
      return;
    }
    if (record.type === "mark" && typeof record.markName === "string") {
      this.playbackMarks.set(record.markName, new Set(this.scheduled));
      this.flushPlaybackMarks();
      return;
    }
    const { audioBase64, turnId, transcript } = extractTalkAudio(payload);
    if (turnId) this.currentTurnId = turnId;
    if (transcript?.final) {
      this.callbacks.onTranscript?.(transcript.text, transcript.role);
    }
    if (audioBase64) {
      try {
        this.enqueue(decodeBase64(audioBase64));
      } catch {
        // Drop the frame. Letting the throw escape `onmessage` would mute the
        // rest of the session over one malformed chunk.
      }
    }
  }

  private enqueue(pcm: ArrayBuffer): void {
    const context = this.context;
    if (!context) return;
    const samples = pcm16ToFloat(pcm);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(1, samples.length, this.outputRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // Keep a cursor so chunks play back-to-back instead of on top of each other.
    const startAt = Math.max(context.currentTime, this.playbackCursor);
    source.start(startAt);
    this.playbackCursor = startAt + buffer.duration;
    this.scheduled.add(source);
    source.onended = () => {
      this.scheduled.delete(source);
      for (const sources of this.playbackMarks.values()) sources.delete(source);
      this.flushPlaybackMarks();
      if (this.scheduled.size === 0 && !this.disposed) {
        this.callbacks.onStatus?.("listening");
      }
    };
    this.callbacks.onStatus?.("speaking");
  }

  /** Stop the assistant mid-sentence and drop whatever is already queued. */
  interrupt(): void {
    this.clearPlayback();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({ type: "cancel", turnId: this.currentTurnId }),
      );
    }
  }

  private flushPlaybackMarks(): void {
    for (const [markName, sources] of this.playbackMarks) {
      if (sources.size > 0) continue;
      this.playbackMarks.delete(markName);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "acknowledgeMark", markName }));
      }
    }
  }

  private clearPlayback(): void {
    for (const source of this.scheduled) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.scheduled.clear();
    this.playbackCursor = 0;
    for (const sources of this.playbackMarks.values()) sources.clear();
    this.flushPlaybackMarks();
  }

  private fail(message: string): void {
    this.callbacks.onError?.(message);
    void this.stop().finally(() => this.callbacks.onStatus?.("error"));
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.interrupt();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "close" }));
      }
      // Closed unconditionally: a socket still in CONNECTING would otherwise be
      // orphaned mid-handshake, and the controller would keep its talk session
      // (and the provider billing behind it) alive with no owner left.
      socket.close();
    }
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.worklet = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    await this.context?.close().catch(() => {});
    this.context = null;
    this.callbacks.onStatus?.("idle");
  }
}
