import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TalkVoiceSession } from "#web/lib/talk-voice";

class TestSocket extends EventTarget {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  static openImmediately = true;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
    this.dispatchEvent(new Event("close"));
  });

  constructor() {
    super();
    TestSocket.instances.push(this);
    queueMicrotask(() => {
      if (!TestSocket.openImmediately) {
        this.close();
        return;
      }
      this.readyState = TestSocket.OPEN;
      this.onopen?.();
    });
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function installAudio() {
  const stopTrack = vi.fn();
  const closeContext = vi.fn().mockResolvedValue(undefined);
  const disconnectWorklet = vi.fn();
  const sources: Array<{
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal("location", { origin: "http://localhost:5173" });
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: stopTrack }],
      }),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      destination = {};
      currentTime = 0;
      close = closeContext;
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      createBuffer = (
        _channels: number,
        length: number,
        sampleRate: number,
      ) => ({
        duration: length / sampleRate,
        copyToChannel: vi.fn(),
      });
      createBufferSource = () => {
        const source = {
          onended: null as (() => void) | null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        sources.push(source);
        return source;
      };
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null, close: vi.fn() };
      connect = vi.fn();
      disconnect = disconnectWorklet;
    },
  );
  return { stopTrack, closeContext, disconnectWorklet, sources };
}

describe("TalkVoiceSession lifecycle", () => {
  beforeEach(() => {
    TestSocket.instances = [];
    TestSocket.openImmediately = true;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("releases microphone and audio resources when the relay socket closes", async () => {
    const audio = installAudio();
    const session = new TalkVoiceSession();
    await session.start({ sessionId: "voice-1" });

    TestSocket.instances[0]?.close();

    expect(audio.stopTrack).toHaveBeenCalled();
    expect(audio.closeContext).toHaveBeenCalled();
    expect(audio.disconnectWorklet).toHaveBeenCalled();
  });

  it("rejects a socket that closes during opening instead of leaving start pending", async () => {
    const audio = installAudio();
    TestSocket.openImmediately = false;
    const session = new TalkVoiceSession();

    await expect(session.start({ sessionId: "voice-1" })).rejects.toThrow(
      "voice stream closed before opening",
    );
    expect(audio.stopTrack).toHaveBeenCalled();
    expect(audio.closeContext).toHaveBeenCalled();
  });

  it.each(["close", "error"])(
    "releases microphone on a terminal %s relay event",
    async (type) => {
      const audio = installAudio();
      const onError = vi.fn();
      const onTranscript = vi.fn();
      const session = new TalkVoiceSession({ onError, onTranscript });
      await session.start({ sessionId: "voice-1" });
      const socket = TestSocket.instances[0];

      socket?.receive({ type, message: "Provider unavailable" });
      socket?.receive({
        type: "transcript",
        role: "user",
        text: "late result",
        final: true,
      });

      expect(audio.stopTrack).toHaveBeenCalled();
      expect(audio.closeContext).toHaveBeenCalled();
      expect(onTranscript).not.toHaveBeenCalled();
      if (type === "error") {
        expect(onError).toHaveBeenCalledWith("Provider unavailable");
      }
    },
  );

  it("acknowledges a mark only after its queued audio has finished", async () => {
    const audio = installAudio();
    const session = new TalkVoiceSession();
    await session.start({ sessionId: "voice-1" });
    const socket = TestSocket.instances[0];

    socket?.receive({
      type: "audio",
      audioBase64: "AAAAAA==",
      talkEvent: {
        type: "output.audio.delta",
        turnId: "turn-1",
        payload: { byteLength: 4 },
      },
    });
    socket?.receive({ type: "mark", markName: "output-1" });

    expect(audio.sources).toHaveLength(1);
    expect(socket?.send).not.toHaveBeenCalled();
    audio.sources[0]?.onended?.();
    expect(socket?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "acknowledgeMark", markName: "output-1" }),
    );
    await session.stop();
  });

  it("drops queued audio on a server clear without sending cancellation back", async () => {
    const audio = installAudio();
    const session = new TalkVoiceSession();
    await session.start({ sessionId: "voice-1" });
    const socket = TestSocket.instances[0];
    socket?.receive({ type: "audio", audioBase64: "AAAAAA==" });
    socket?.receive({ type: "mark", markName: "output-1" });

    socket?.receive({ type: "clear" });

    expect(audio.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(socket?.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: "acknowledgeMark", markName: "output-1" }),
    );
    expect(audio.stopTrack).not.toHaveBeenCalled();
    await session.stop();
  });
});
