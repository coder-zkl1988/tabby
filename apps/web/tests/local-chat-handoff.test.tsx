// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalChatPage } from "../src/pages/local-chat";

const { startChat } = vi.hoisted(() => ({ startChat: vi.fn() }));
vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Bots: async () => ({
    data: { bots: [{ id: "bot-1", name: "Tabby", status: "active" }] },
  }),
  getApiV1BotsDefault: async () => ({ data: { id: "bot-1" } }),
  getApiV1ChatSession: vi.fn(),
  patchApiV1BotsByBotId: vi.fn(),
  putApiV1BotsDefault: vi.fn(),
  postApiV1ChatLocalStart: startChat,
}));
vi.mock("@/lib/desktop-host", () => ({ invokeDesktopHost: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/chat-input-area", () => ({
  ChatInputArea: ({
    onSend,
    disabled,
  }: {
    onSend: (
      text: string,
      attachments: Array<{
        type: "file";
        content: string;
        filename: string;
        mimeType: string;
      }>,
      skillSlug: null,
    ) => Promise<boolean>;
    disabled: boolean;
  }) => (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void onSend(
            "Summarize this file",
            [
              {
                type: "file",
                content: "fixture",
                filename: "notes.txt",
                mimeType: "text/plain",
              },
            ],
            null,
          )
        }
      >
        Send file
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onSend("Hello", [], null)}
      >
        Send text
      </button>
    </>
  ),
}));

function LocationState() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ path: location.pathname, state: location.state })}
    </output>
  );
}

afterEach(cleanup);

describe("new conversation optimistic handoff", () => {
  it.each([true, false])(
    "does not duplicate attachment captions when session indexed=%s",
    async (indexed) => {
      startChat.mockResolvedValue({
        data: {
          session: indexed ? { id: "saved-session" } : null,
          message: { runId: "run-1" },
        },
      });
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter initialEntries={["/workspace/chat"]}>
            <LocalChatPage />
            <LocationState />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Send file",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send file" }));
      await waitFor(() =>
        expect(screen.getByTestId("location").textContent).toContain(
          "/workspace/sessions/",
        ),
      );
      const result = JSON.parse(
        screen.getByTestId("location").textContent ?? "{}",
      );
      expect(
        result.state[indexed ? "deskpetPendingUserText" : "pendingUserText"],
      ).toBe("");
      expect(startChat.mock.lastCall?.[0].body.message.content).toBe(
        "Summarize this file",
      );
      expect(
        startChat.mock.lastCall?.[0].body.message.attachments,
      ).toHaveLength(1);
      if (indexed) expect(result.state.deskpetPendingRunId).toBe("run-1");
      else expect(result.state.pendingText).toBe("Summarize this file");
    },
  );

  it("keeps the optimistic text for plain messages", async () => {
    startChat.mockResolvedValue({
      data: { session: { id: "saved-session" }, message: { runId: "run-1" } },
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/workspace/chat"]}>
          <LocalChatPage />
          <LocationState />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Send text" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        '"deskpetPendingUserText":"Hello"',
      ),
    );
  });
});
