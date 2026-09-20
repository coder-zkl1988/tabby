import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentQuestionPanel } from "#web/components/agent-question-panel";

const apiMocks = vi.hoisted(() => ({
  listQuestions: vi.fn(),
  resolveQuestion: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@web-gen/api/sdk.gen", () => ({
  getApiV1RuntimeQuestions: (...args: unknown[]) =>
    apiMocks.listQuestions(...args),
  postApiV1RuntimeQuestionsByQuestionIdResolve: (...args: unknown[]) =>
    apiMocks.resolveQuestion(...args),
}));

function renderPanel(sessionKey?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentQuestionPanel sessionKey={sessionKey} />
    </QueryClientProvider>,
  );
}

function questionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    sessionKey: "session-a",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 900_000,
    status: "pending",
    questions: [
      {
        questionId: "deploy_target",
        header: "Deploy",
        question: "Where should this go?",
        options: [
          { label: "Staging (Recommended)" },
          { label: "Production", description: "Live traffic" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("AgentQuestionPanel", () => {
  beforeEach(() => {
    apiMocks.listQuestions.mockReset();
    apiMocks.resolveQuestion.mockReset();
    apiMocks.resolveQuestion.mockResolvedValue({ data: { ok: true } });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when no question is pending", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: { connected: true, available: true, questions: [] },
    });
    const { container } = renderPanel("session-a");
    await waitFor(() => expect(apiMocks.listQuestions).toHaveBeenCalled());
    expect(container.querySelector("[data-agent-question]")).toBeNull();
  });

  // The local sessionKey is undefined until the session-meta query resolves.
  // Treating that as a wildcard rendered another session's prompt here, and a
  // click would answer it — which cannot be taken back.
  it("hides a prompt owned by another session while its own key is unknown", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [questionRecord({ sessionKey: "session-b" })],
      },
    });
    const { container } = renderPanel(undefined);
    await waitFor(() => expect(apiMocks.listQuestions).toHaveBeenCalled());
    expect(container.querySelector("[data-agent-question]")).toBeNull();
  });

  it("hides a prompt owned by a different session", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [questionRecord({ sessionKey: "session-b" })],
      },
    });
    const { container } = renderPanel("session-a");
    await waitFor(() => expect(apiMocks.listQuestions).toHaveBeenCalled());
    expect(container.querySelector("[data-agent-question]")).toBeNull();
  });

  // A record with no sessionKey is gateway-wide and still belongs everywhere.
  it("still shows a gateway-wide prompt that names no session", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [questionRecord({ sessionKey: undefined })],
      },
    });
    renderPanel("session-a");
    expect(await screen.findByText("Staging (Recommended)")).toBeTruthy();
  });

  it("answers a single-select question with the chosen label", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: { connected: true, available: true, questions: [questionRecord()] },
    });
    renderPanel("session-a");

    const option = await screen.findByText("Staging (Recommended)");
    fireEvent.click(option);

    await waitFor(() => expect(apiMocks.resolveQuestion).toHaveBeenCalled());
    expect(apiMocks.resolveQuestion).toHaveBeenCalledWith({
      path: { questionId: "q-1" },
      body: { answers: { deploy_target: ["Staging (Recommended)"] } },
    });
  });

  it("skips the whole prompt without answers", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: { connected: true, available: true, questions: [questionRecord()] },
    });
    renderPanel("session-a");

    const skip = await screen.findByText("sessions.chat.agentQuestionSkip");
    fireEvent.click(skip);

    await waitFor(() => expect(apiMocks.resolveQuestion).toHaveBeenCalled());
    expect(apiMocks.resolveQuestion).toHaveBeenCalledWith({
      path: { questionId: "q-1" },
      body: { skip: true },
    });
  });

  it("collects every answer before resolving a multi-question prompt", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [
          questionRecord({
            questions: [
              {
                questionId: "first",
                header: "One",
                question: "First?",
                options: [{ label: "A" }, { label: "B" }],
              },
              {
                questionId: "second",
                header: "Two",
                question: "Second?",
                options: [{ label: "C" }, { label: "D" }],
              },
            ],
          }),
        ],
      },
    });
    renderPanel("session-a");

    fireEvent.click(await screen.findByText("A"));
    // The first answer must not resolve the record on its own.
    expect(apiMocks.resolveQuestion).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText("D"));
    await waitFor(() => expect(apiMocks.resolveQuestion).toHaveBeenCalled());
    expect(apiMocks.resolveQuestion).toHaveBeenCalledWith({
      path: { questionId: "q-1" },
      body: { answers: { first: ["A"], second: ["D"] } },
    });
  });

  it("submits multiple values for a multiSelect question", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [
          questionRecord({
            questions: [
              {
                questionId: "features",
                header: "Pick",
                question: "Which ones?",
                options: [{ label: "A" }, { label: "B" }],
                multiSelect: true,
              },
            ],
          }),
        ],
      },
    });
    renderPanel("session-a");

    fireEvent.click(await screen.findByText("A"));
    fireEvent.click(await screen.findByText("B"));
    // multiSelect waits for an explicit confirm rather than resolving per click.
    expect(apiMocks.resolveQuestion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("sessions.chat.agentQuestionConfirm"));
    await waitFor(() => expect(apiMocks.resolveQuestion).toHaveBeenCalled());
    expect(apiMocks.resolveQuestion).toHaveBeenCalledWith({
      path: { questionId: "q-1" },
      body: { answers: { features: ["A", "B"] } },
    });
  });

  it("ignores a question belonging to a different session", async () => {
    apiMocks.listQuestions.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        questions: [questionRecord({ sessionKey: "session-b" })],
      },
    });
    const { container } = renderPanel("session-a");
    await waitFor(() => expect(apiMocks.listQuestions).toHaveBeenCalled());
    expect(container.querySelector("[data-agent-question]")).toBeNull();
  });
});
