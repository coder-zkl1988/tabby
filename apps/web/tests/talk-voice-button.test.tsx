// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TalkVoiceButton } from "../src/components/talk-voice-button";
import en from "../src/i18n/locales/en";
import zhCN from "../src/i18n/locales/zh-CN";
import type { TalkSessionCallbacks } from "../src/lib/talk-voice";

const { catalog, createSession, sessions, startSession, toastError, locale } =
  vi.hoisted(() => ({
    catalog: vi.fn(),
    createSession: vi.fn(),
    startSession: vi.fn(),
    toastError: vi.fn(),
    locale: { current: "en" },
    sessions: [] as Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      callbacks: TalkSessionCallbacks;
    }>,
  }));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1TalkCatalog: catalog,
  postApiV1TalkSessions: createSession,
}));

vi.mock("@/lib/talk-voice", () => ({
  TalkVoiceSession: class {
    start = vi.fn(async () => {
      await startSession();
      this.callbacks.onStatus?.("listening");
    });
    stop = vi.fn(async () => this.callbacks.onStatus?.("idle"));

    constructor(readonly callbacks: TalkSessionCallbacks) {
      sessions.push(this);
    }
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations = locale.current === "zh-CN" ? zhCN : en;
      return translations[key as keyof typeof translations] ?? key;
    },
  }),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

const voiceSession = {
  data: {
    sessionId: "voice-1",
    inputSampleRateHz: 24000,
    outputSampleRateHz: 24000,
  },
};

beforeEach(() => {
  catalog.mockReset().mockResolvedValue({ data: { ready: true } });
  createSession.mockReset().mockResolvedValue(voiceSession);
  startSession.mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  locale.current = "en";
  sessions.length = 0;
});
afterEach(cleanup);

function renderButton(
  props: {
    sessionKey?: string;
    disabled?: boolean;
    onSessionEnded?: () => void | Promise<void>;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = (nextProps: typeof props) => (
    <QueryClientProvider client={client}>
      <TalkVoiceButton key={nextProps.sessionKey} {...nextProps} />
    </QueryClientProvider>
  );
  const rendered = render(view(props));
  return {
    ...rendered,
    client,
    rerenderButton: (nextProps: typeof props) =>
      rendered.rerender(view(nextProps)),
  };
}

describe("voice composer control", () => {
  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ])(
    "explains provider failures in %s without blaming the microphone",
    async (language, translations) => {
      locale.current = language;
      renderButton();
      fireEvent.click(
        await screen.findByRole("button", {
          name: translations["sessions.chat.talkStart"],
        }),
      );
      await waitFor(() => expect(sessions[0]?.start).toHaveBeenCalled());

      act(() => sessions[0]?.callbacks.onError?.("Realtime provider error."));

      expect(toastError).toHaveBeenCalledWith(
        translations["sessions.chat.talkConnectionFailed"],
      );
    },
  );

  it.each([
    [
      new DOMException("Permission denied", "NotAllowedError"),
      "sessions.chat.talkMicrophoneDenied",
    ],
    [
      new DOMException("Device missing", "NotFoundError"),
      "sessions.chat.talkMicrophoneMissing",
    ],
    [
      new Error("voice stream failed to open"),
      "sessions.chat.talkConnectionFailed",
    ],
  ] as const)(
    "explains startup error %s and releases the session",
    async (error, key) => {
      startSession.mockRejectedValueOnce(error);
      renderButton();
      fireEvent.click(
        await screen.findByRole("button", {
          name: en["sessions.chat.talkStart"],
        }),
      );

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(en[key]));
      expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
      expect(
        screen
          .getByRole("button", { name: en["sessions.chat.talkStart"] })
          .getAttribute("aria-pressed"),
      ).toBe("false");
    },
  );

  it("preserves unexpected provider details", async () => {
    renderButton();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(sessions[0]?.start).toHaveBeenCalled());

    act(() =>
      sessions[0]?.callbacks.onError?.("Selected voice is unavailable."),
    );

    expect(toastError).toHaveBeenCalledWith("Selected voice is unavailable.");
  });

  it("hides the microphone when the provider is not ready", async () => {
    catalog.mockResolvedValue({ data: { ready: false } });
    const { client } = renderButton();
    await waitFor(() =>
      expect(client.getQueryState(["talk-catalog"])?.status).toBe("success"),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not create a voice session while disabled", async () => {
    renderButton({ disabled: true });
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStart"],
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(createSession).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it("starts the bound session and awaits stop before notifying the page", async () => {
    const ended = vi.fn();
    renderButton({
      sessionKey: "agent:bot-1:conversation-1",
      onSessionEnded: ended,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    const stopButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStop"],
    });
    await waitFor(() => expect(stopButton.disabled).toBe(false));
    expect(createSession).toHaveBeenCalledWith({
      body: { sessionKey: "agent:bot-1:conversation-1" },
      signal: expect.any(AbortSignal),
    });
    expect(sessions[0]?.start).toHaveBeenCalledWith(voiceSession.data);
    expect(stopButton.getAttribute("aria-pressed")).toBe("true");

    let finishStop: (() => void) | undefined;
    sessions[0]?.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    fireEvent.click(stopButton);
    expect(ended).not.toHaveBeenCalled();
    await act(async () => finishStop?.());
    await screen.findByRole("button", { name: en["sessions.chat.talkStart"] });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("keeps stop available if the composer becomes disabled during a call", async () => {
    const { rerenderButton } = renderButton({
      sessionKey: "agent:bot-1:conversation-1",
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(sessions[0]?.start).toHaveBeenCalled());
    rerenderButton({
      sessionKey: "agent:bot-1:conversation-1",
      disabled: true,
    });
    const stop = screen.getByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStop"],
    });
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(sessions[0]?.stop).toHaveBeenCalledTimes(1));
  });

  it("aborts a pending request on unmount without starting the microphone", async () => {
    let resolveRequest: ((value: typeof voiceSession) => void) | undefined;
    createSession.mockImplementationOnce(
      () =>
        new Promise<typeof voiceSession>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const ended = vi.fn();
    const { unmount } = renderButton({
      sessionKey: "agent:bot-1:conversation-1",
      onSessionEnded: ended,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    const request = createSession.mock.calls[0]?.[0] as { signal: AbortSignal };
    unmount();
    expect(request.signal.aborted).toBe(true);
    await act(async () => resolveRequest?.(voiceSession));
    expect(sessions).toHaveLength(0);
    expect(ended).not.toHaveBeenCalled();
  });

  it("cleans up the previous key without navigating when the composer changes sessions", async () => {
    const ended = vi.fn();
    const { rerenderButton, unmount } = renderButton({
      sessionKey: "agent:bot-1:conversation-1",
      onSessionEnded: ended,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(sessions[0]?.start).toHaveBeenCalled());
    rerenderButton({
      sessionKey: "agent:bot-2:conversation-2",
      onSessionEnded: ended,
    });
    expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(sessions[1]?.start).toHaveBeenCalled());
    expect(createSession.mock.calls[1]?.[0].body).toEqual({
      sessionKey: "agent:bot-2:conversation-2",
    });
    unmount();
    expect(sessions[1]?.stop).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });
});
