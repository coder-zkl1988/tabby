// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en";
import type { TalkSessionCallbacks } from "../src/lib/talk-voice";
import { LocalChatPage } from "../src/pages/local-chat";

const {
  startChat,
  createVoiceSession,
  getChatSession,
  voiceSessions,
  bot,
  otherBot,
} = vi.hoisted(() => ({
  startChat: vi.fn(),
  createVoiceSession: vi.fn(),
  getChatSession: vi.fn(),
  voiceSessions: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
  bot: {
    id: "bot-1",
    name: "Tabby",
    slug: "tabby",
    status: "active",
    modelId: null,
  },
  otherBot: {
    id: "bot-2",
    name: "Other expert",
    slug: "other-expert",
    status: "active",
    modelId: null,
  },
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Bots: vi.fn(async () => ({ data: { bots: [bot, otherBot] } })),
  getApiV1BotsDefault: vi.fn(async () => ({ data: bot })),
  getApiV1Models: vi.fn(async () => ({ data: { models: [] } })),
  getApiInternalDesktopDefaultModel: vi.fn(async () => ({
    data: { modelId: null },
  })),
  patchApiV1BotsByBotId: vi.fn(),
  putApiV1BotsDefault: vi.fn(),
  postApiV1ChatLocalStart: startChat,
  getApiV1TalkCatalog: vi.fn(async () => ({ data: { ready: true } })),
  postApiV1TalkSessions: createVoiceSession,
  getApiV1ChatSession: getChatSession,
}));

vi.mock("@/lib/talk-voice", () => ({
  TalkVoiceSession: class {
    stop = vi.fn(async () => this.callbacks.onStatus?.("idle"));

    constructor(private readonly callbacks: TalkSessionCallbacks) {
      voiceSessions.push(this);
    }

    async start() {
      this.callbacks.onStatus?.("listening");
    }
  },
}));

vi.mock("@/hooks/use-community-catalog", () => ({
  useCommunitySkillStatus: () => ({ data: { installedSkills: [] } }),
}));

vi.mock("@/hooks/use-teams", () => ({
  useTeams: () => ({ data: { teams: [] } }),
}));

vi.mock("@/lib/desktop-host", () => ({
  invokeDesktopHost: vi.fn(),
  requestDesktopHost: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => en[key as keyof typeof en] ?? key,
  }),
}));

afterEach(cleanup);
beforeEach(() => {
  startChat.mockReset();
  createVoiceSession.mockReset().mockResolvedValue({
    data: {
      sessionId: "voice-1",
      inputSampleRateHz: 24000,
      outputSampleRateHz: 24000,
    },
  });
  getChatSession.mockReset().mockResolvedValue({ data: { session: null } });
  voiceSessions.length = 0;
});

async function renderComposer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/workspace/chat"]}>
        <Routes>
          <Route path="/workspace/chat" element={<LocalChatPage />} />
          <Route
            path="/workspace/sessions/pending"
            element={<p>Conversation pending</p>}
          />
          <Route
            path="/workspace/sessions/saved-voice"
            element={<p>Saved voice conversation</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: "Please help with this draft" } });
  return input;
}

describe("new conversation submit", () => {
  it("places voice immediately beside submit and opens the saved voice conversation", async () => {
    getChatSession.mockResolvedValueOnce({
      data: { session: { id: "saved-voice" } },
    });
    const input = await renderComposer();
    fireEvent.change(input, { target: { value: "" } });
    const voice = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStart"],
    });
    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.sendRunMessage"],
    });
    expect(voice.nextElementSibling).toBe(send);
    expect(voice.disabled).toBe(false);
    expect(send.disabled).toBe(true);
    fireEvent.click(voice);
    const stop = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStop"],
    });
    await waitFor(() => expect(stop.disabled).toBe(false));
    const voiceKey = createVoiceSession.mock.calls[0]?.[0].body
      .sessionKey as string;
    expect(voiceKey).toMatch(/^agent:bot-1:[0-9a-f-]{36}$/);
    fireEvent.click(stop);
    await screen.findByText("Saved voice conversation");
    expect(getChatSession).toHaveBeenCalledWith({
      query: { botId: bot.id, sessionKey: voiceKey },
    });
    expect(voiceSessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("reuses the voice conversation key for a following text message", async () => {
    startChat.mockResolvedValueOnce({
      data: { session: null, message: { runId: "run-1" } },
    });
    await renderComposer();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    const stop = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStop"],
    });
    await waitFor(() => expect(stop.disabled).toBe(false));
    const voiceKey = createVoiceSession.mock.calls[0]?.[0].body.sessionKey;
    fireEvent.click(stop);
    await waitFor(() => expect(getChatSession).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: en["sessions.chat.sendRunMessage"] }),
    );
    await screen.findByText("Conversation pending");
    expect(startChat.mock.calls[0]?.[0].body).toMatchObject({
      botId: bot.id,
      sessionKey: voiceKey,
    });
  });

  it("allocates a fresh voice conversation key on a new visit for the same bot", async () => {
    await renderComposer();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(voiceSessions).toHaveLength(1));
    const firstKey = createVoiceSession.mock.calls[0]?.[0].body.sessionKey;
    cleanup();

    await renderComposer();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(voiceSessions).toHaveLength(2));
    const secondKey = createVoiceSession.mock.calls[1]?.[0].body.sessionKey;
    expect(secondKey).toMatch(/^agent:bot-1:[0-9a-f-]{36}$/);
    expect(secondKey).not.toBe(firstKey);
  });

  it("stops the old bot's voice session and binds the newly selected bot", async () => {
    await renderComposer();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    const stop = await screen.findByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.talkStop"],
    });
    await waitFor(() => expect(stop.disabled).toBe(false));
    const firstKey = createVoiceSession.mock.calls[0]?.[0].body
      .sessionKey as string;

    fireEvent.click(screen.getByRole("button", { name: bot.name }));
    fireEvent.click(screen.getByRole("button", { name: otherBot.name }));
    expect(voiceSessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(getChatSession).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sessions.chat.talkStart"],
      }),
    );
    await waitFor(() => expect(createVoiceSession).toHaveBeenCalledTimes(2));
    expect(createVoiceSession.mock.calls[1]?.[0].body.sessionKey).toBe(
      firstKey.replace("agent:bot-1:", "agent:bot-2:"),
    );
  });

  it("shows a rejected send, preserves the draft, and lets the user retry", async () => {
    startChat.mockResolvedValueOnce({
      error: { message: "Agent no longer exists" },
    });
    const input = await renderComposer();
    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: en["sessions.chat.sendRunMessage"],
    });
    fireEvent.click(send);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en["localChat.sendFailed"]);
    expect(alert.textContent).toContain("Agent no longer exists");
    expect(input.value).toBe("Please help with this draft");
    expect(send.disabled).toBe(false);
    const firstBody = startChat.mock.calls[0]?.[0].body;
    expect(firstBody.message.content).toBe("Please help with this draft");

    startChat.mockResolvedValueOnce({
      data: { session: null, message: { runId: "run-1" } },
    });
    fireEvent.click(send);
    await screen.findByText("Conversation pending");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startChat.mock.calls[1]?.[0].body).toEqual(firstBody);
  });

  it.each([
    [new Error("Network unavailable"), "Network unavailable"],
    [undefined, null],
  ])(
    "shows a failed request without discarding text (%s)",
    async (error, detail) => {
      startChat.mockRejectedValueOnce(error);
      const input = await renderComposer();
      fireEvent.keyDown(input, { key: "Enter" });

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(en["localChat.sendFailed"]);
      if (detail) expect(alert.textContent).toContain(detail);
      expect(input.value).toBe("Please help with this draft");
      expect(input.disabled).toBe(false);
      expect(screen.queryByText("Conversation pending")).toBeNull();
    },
  );
});
