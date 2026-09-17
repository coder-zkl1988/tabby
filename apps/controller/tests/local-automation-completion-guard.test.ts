import { describe, expect, it } from "vitest";
import { LocalAutomationCompletionGuard } from "../src/services/local-automation-completion-guard.js";

function toolEvent(params: {
  runId: string;
  phase: "start" | "result";
  name: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: unknown;
}): Record<string, unknown> {
  return {
    runId: params.runId,
    stream: "tool",
    data: {
      phase: params.phase,
      name: params.name,
      toolCallId: params.toolCallId,
      ...(params.args ? { args: params.args } : {}),
      ...(params.isError === undefined ? {} : { isError: params.isError }),
      ...(params.result === undefined ? {} : { result: params.result }),
    },
  };
}

describe("LocalAutomationCompletionGuard", () => {
  it("blocks final success after an action receipt and failed observation", () => {
    const guard = new LocalAutomationCompletionGuard();
    guard.observeAgentEvent(
      toolEvent({
        runId: "run-1",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-1",
        args: { app: "PID:18609", text: "锦鲤" },
      }),
    );
    guard.observeAgentEvent(
      toolEvent({
        runId: "run-1",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-1",
        isError: false,
      }),
    );
    guard.observeAgentEvent(
      toolEvent({
        runId: "run-1",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-1",
        args: { app_target: "PID:18609" },
      }),
    );
    guard.observeAgentEvent(
      toolEvent({
        runId: "run-1",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-1",
        isError: true,
      }),
    );

    expect(guard.finalFailureFor("run-1")).toMatchObject({
      errorKind: "local_automation_unverified",
      errorMessage: expect.stringContaining("未确认完成"),
    });
    expect(guard.finalFailureFor("run-1")).toMatchObject({
      errorKind: "local_automation_unverified",
    });
  });

  it("allows final success after CUA reports the expected value for the same element", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-2",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-2",
        args: {
          app: "com.electron.lark",
          element_index: 42,
          text: "锦鲤",
        },
      }),
      toolEvent({
        runId: "run-2",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-2",
        isError: false,
      }),
      toolEvent({
        runId: "run-2",
        phase: "start",
        name: "cua-driver__get_window_state",
        toolCallId: "state-2",
        args: { app: "com.electron.lark" },
      }),
      toolEvent({
        runId: "run-2",
        phase: "result",
        name: "cua-driver__get_window_state",
        toolCallId: "state-2",
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: '42 text field Search value="锦鲤"',
            },
          ],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-2")).toBeNull();
  });

  it("rejects state evidence from a different target", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-3",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-3",
        args: { app: "飞书", element_id: 42 },
      }),
      toolEvent({
        runId: "run-3",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-3",
        isError: false,
      }),
      toolEvent({
        runId: "run-3",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-3",
        args: { app_target: "Safari" },
      }),
      toolEvent({
        runId: "run-3",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-3",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-3")).not.toBeNull();
  });

  it("does not treat an unchanged same-target observation as click completion", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-click-unchanged",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-unchanged",
        args: { app: "Safari", on: "submit-button" },
      }),
      toolEvent({
        runId: "run-click-unchanged",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-unchanged",
        isError: false,
      }),
      toolEvent({
        runId: "run-click-unchanged",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-unchanged",
        args: { app_target: "Safari" },
      }),
      toolEvent({
        runId: "run-click-unchanged",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-unchanged",
        isError: false,
        result: {
          content: [
            { type: "text", text: "UI unchanged; button still present" },
          ],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-click-unchanged")).not.toBeNull();
  });

  it("tracks app launches while keeping app list read-only", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-app-launch",
        phase: "start",
        name: "cua-driver__launch_app",
        toolCallId: "app-launch",
        args: { name: "TextEdit" },
      }),
      toolEvent({
        runId: "run-app-launch",
        phase: "result",
        name: "cua-driver__launch_app",
        toolCallId: "app-launch",
        isError: false,
      }),
      toolEvent({
        runId: "run-app-list",
        phase: "start",
        name: "cua-driver__list_apps",
        toolCallId: "app-list",
      }),
      toolEvent({
        runId: "run-app-list",
        phase: "result",
        name: "cua-driver__list_apps",
        toolCallId: "app-list",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-app-launch")).not.toBeNull();
    expect(guard.finalFailureFor("run-app-list")).toBeNull();
  });

  it("fails closed for an unknown backend action and ignores explicit read-only tools", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-unknown-action",
        phase: "start",
        name: "cua-driver__future_widget",
        toolCallId: "paste-1",
        args: { app: "TextEdit", text: "sensitive" },
      }),
      toolEvent({
        runId: "run-unknown-action",
        phase: "result",
        name: "cua-driver__future_widget",
        toolCallId: "paste-1",
        isError: false,
      }),
      toolEvent({
        runId: "run-read-only",
        phase: "start",
        name: "cua-driver__list_apps",
        toolCallId: "list-1",
        args: { item_type: "running_applications" },
      }),
      toolEvent({
        runId: "run-read-only",
        phase: "result",
        name: "cua-driver__list_apps",
        toolCallId: "list-1",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-unknown-action")).not.toBeNull();
    expect(guard.finalFailureFor("run-read-only")).toBeNull();
  });

  it("does not let a different successful action hide an earlier failure", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-4",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-4",
        args: { app: "飞书", text: "锦鲤" },
      }),
      toolEvent({
        runId: "run-4",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-4",
        isError: true,
      }),
      toolEvent({
        runId: "run-4",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-4",
        args: { app: "飞书", x: 100, y: 120 },
      }),
      toolEvent({
        runId: "run-4",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-4",
        isError: false,
      }),
      toolEvent({
        runId: "run-4",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-4",
        args: { app: "飞书" },
      }),
      toolEvent({
        runId: "run-4",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-4",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-4")?.errorKind).toBe(
      "local_automation_unverified",
    );
  });

  it("accepts an exact successful retry followed by fresh evidence", () => {
    const guard = new LocalAutomationCompletionGuard();
    const args = { app: "飞书", element_id: "search-5", text: "锦鲤" };
    for (const event of [
      toolEvent({
        runId: "run-5",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-5a",
        args,
      }),
      toolEvent({
        runId: "run-5",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-5a",
        isError: true,
      }),
      toolEvent({
        runId: "run-5",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-5b",
        args,
      }),
      toolEvent({
        runId: "run-5",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-5b",
        isError: false,
      }),
      toolEvent({
        runId: "run-5",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-5",
        args: { app: "飞书" },
      }),
      toolEvent({
        runId: "run-5",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-5",
        isError: false,
        result: {
          elements: [{ element_id: "search-5", value: "锦鲤" }],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-5")).toBeNull();
  });

  it("rejects a successful observation that lacks the expected input value", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-6",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-6",
        args: { app: "飞书", element_id: "search-6", text: "锦鲤" },
      }),
      toolEvent({
        runId: "run-6",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-6",
        isError: false,
      }),
      toolEvent({
        runId: "run-6",
        phase: "start",
        name: "cua-driver__hotkey",
        toolCallId: "enter-6",
        args: { app: "飞书", keys: "return" },
      }),
      toolEvent({
        runId: "run-6",
        phase: "result",
        name: "cua-driver__hotkey",
        toolCallId: "enter-6",
        isError: false,
      }),
      toolEvent({
        runId: "run-6",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-6",
        args: { app: "飞书" },
      }),
      toolEvent({
        runId: "run-6",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-6",
        isError: false,
        result: {
          elements: [
            { element_id: "search-6", value: "" },
            { element_id: "other", text: "锦鲤" },
          ],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-6")).not.toBeNull();
  });

  it("does not mistake a static element label for its value", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-label-only",
        phase: "start",
        name: "cua-driver__type_text",
        toolCallId: "type-label-only",
        args: { app: "Safari", on: "search-field", text: "Search" },
      }),
      toolEvent({
        runId: "run-label-only",
        phase: "result",
        name: "cua-driver__type_text",
        toolCallId: "type-label-only",
        isError: false,
      }),
      toolEvent({
        runId: "run-label-only",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-label-only",
        args: { app_target: "Safari" },
      }),
      toolEvent({
        runId: "run-label-only",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-label-only",
        isError: false,
        result: {
          elements: [
            { element_id: "search-field", label: "Search", value: "" },
          ],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-label-only")).not.toBeNull();
  });

  it("accepts on references in MCP text value evidence", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-on-ref",
        phase: "start",
        name: "cua-driver__set_value",
        toolCallId: "set-on-ref",
        args: { on: "search-field", snapshot: "snapshot-1", value: "锦鲤" },
      }),
      toolEvent({
        runId: "run-on-ref",
        phase: "result",
        name: "cua-driver__set_value",
        toolCallId: "set-on-ref",
        isError: false,
      }),
      toolEvent({
        runId: "run-on-ref",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-on-ref",
        args: { app_target: "Safari", snapshot: "snapshot-1" },
      }),
      toolEvent({
        runId: "run-on-ref",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-on-ref",
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: 'search-field text field value="锦鲤"',
            },
          ],
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-on-ref")).toBeNull();
  });

  it("accepts cua-driver 0.12.6 native verification", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-provider-verified",
        phase: "start",
        name: "cua-driver__set_value",
        toolCallId: "set-provider-verified",
        args: { app: "Notepad", element_index: 3, value: "锦鲤" },
      }),
      toolEvent({
        runId: "run-provider-verified",
        phase: "result",
        name: "cua-driver__set_value",
        toolCallId: "set-provider-verified",
        isError: false,
        result: {
          details: {
            structuredContent: {
              path: "msaa",
              verified: true,
              effect: "confirmed",
            },
          },
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-provider-verified")).toBeNull();
  });

  it("rejects provider verification serialized as arbitrary text", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const runId of ["run-provider-text", "run-provider-content-text"]) {
      const verificationText = JSON.stringify({
        action: {
          element_index: 3,
          verification: {
            state: "verified",
            property: "value",
            expected: "hello",
          },
        },
      });
      for (const event of [
        toolEvent({
          runId,
          phase: "start",
          name: "cua-driver__set_value",
          toolCallId: `set-${runId}`,
          args: { app: "Notepad", element_index: 3, value: "hello" },
        }),
        toolEvent({
          runId,
          phase: "result",
          name: "cua-driver__set_value",
          toolCallId: `set-${runId}`,
          isError: false,
          result:
            runId === "run-provider-text"
              ? verificationText
              : { content: [{ type: "text", text: verificationText }] },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor(runId)).not.toBeNull();
    }
  });

  it("rejects provider verification without an explicit target", () => {
    const guard = new LocalAutomationCompletionGuard();
    const cases = [
      {
        runId: "run-targetless-native-verification",
        args: { element_index: 3, value: "hello" },
        result: { verified: true },
      },
      {
        runId: "run-frontmost-enriched-verification",
        args: { app: "frontmost", element_index: 3, value: "hello" },
        result: {
          action: {
            element_index: 3,
            verification: {
              state: "verified",
              property: "value",
              expected: "hello",
            },
          },
        },
      },
    ];

    for (const testCase of cases) {
      for (const event of [
        toolEvent({
          runId: testCase.runId,
          phase: "start",
          name: "cua-driver__set_value",
          toolCallId: `set-${testCase.runId}`,
          args: testCase.args,
        }),
        toolEvent({
          runId: testCase.runId,
          phase: "result",
          name: "cua-driver__set_value",
          toolCallId: `set-${testCase.runId}`,
          isError: false,
          result: testCase.result,
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor(testCase.runId)).not.toBeNull();
    }
  });

  it("rejects a final answer while a mutation call has no result", () => {
    const guard = new LocalAutomationCompletionGuard();
    guard.observeAgentEvent(
      toolEvent({
        runId: "run-mutation-in-flight",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-in-flight",
        args: { app: "Safari", x: 10, y: 20 },
      }),
    );

    expect(guard.finalFailureFor("run-mutation-in-flight")).not.toBeNull();
  });

  it("accepts exact empty values but not an empty type receipt", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const runId of ["run-empty-value", "run-empty-type"]) {
      const toolName =
        runId === "run-empty-value"
          ? "cua-driver__set_value"
          : "cua-driver__type_text";
      const args =
        runId === "run-empty-value"
          ? { app: "Safari", on: "field", value: "" }
          : { app: "Safari", on: "field", text: "" };
      for (const event of [
        toolEvent({
          runId,
          phase: "start",
          name: toolName,
          toolCallId: `action-${runId}`,
          args,
        }),
        toolEvent({
          runId,
          phase: "result",
          name: toolName,
          toolCallId: `action-${runId}`,
          isError: false,
        }),
        toolEvent({
          runId,
          phase: "start",
          name: "cua-driver__get_accessibility_tree",
          toolCallId: `inspect-${runId}`,
          args: { app_target: "Safari" },
        }),
        toolEvent({
          runId,
          phase: "result",
          name: "cua-driver__get_accessibility_tree",
          toolCallId: `inspect-${runId}`,
          isError: false,
          result: {
            content: [{ type: "text", text: 'field text field value=""' }],
          },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }
    }

    expect(guard.finalFailureFor("run-empty-value")).toBeNull();
    expect(guard.finalFailureFor("run-empty-type")).not.toBeNull();
  });

  it("rejects text value evidence from prefix-colliding element references", () => {
    const guard = new LocalAutomationCompletionGuard();
    const cases = [
      {
        runId: "run-other-field",
        target: "field",
        value: "",
        evidence: 'other-field text field value=""',
      },
      {
        runId: "run-b10",
        target: "B1",
        value: "锦鲤",
        evidence: 'B10 text field value="锦鲤"',
      },
      {
        runId: "run-value-suffix",
        target: "field",
        value: "hello",
        evidence: 'field text field value="hello world"',
      },
      {
        runId: "run-default-value",
        target: "field",
        value: "hello",
        evidence: 'field default_value="hello" value="different"',
      },
      {
        runId: "run-default-space-value",
        target: "field",
        value: "hello",
        evidence: 'field default value="hello" current="different"',
      },
      {
        runId: "run-multiple-element-fields",
        target: "field",
        value: "hello",
        evidence:
          'element_id="field", value="wrong"; element_id="other", value="hello"',
      },
    ];

    for (const testCase of cases) {
      for (const event of [
        toolEvent({
          runId: testCase.runId,
          phase: "start",
          name: "cua-driver__set_value",
          toolCallId: `set-${testCase.runId}`,
          args: {
            app: "Safari",
            on: testCase.target,
            value: testCase.value,
          },
        }),
        toolEvent({
          runId: testCase.runId,
          phase: "result",
          name: "cua-driver__set_value",
          toolCallId: `set-${testCase.runId}`,
          isError: false,
        }),
        toolEvent({
          runId: testCase.runId,
          phase: "start",
          name: "cua-driver__get_accessibility_tree",
          toolCallId: `inspect-${testCase.runId}`,
          args: { app_target: "Safari" },
        }),
        toolEvent({
          runId: testCase.runId,
          phase: "result",
          name: "cua-driver__get_accessibility_tree",
          toolCallId: `inspect-${testCase.runId}`,
          isError: false,
          result: {
            content: [{ type: "text", text: testCase.evidence }],
          },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor(testCase.runId)).not.toBeNull();
    }
  });

  it("rejects substring value evidence and mismatched provider verification", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-substring-value",
        phase: "start",
        name: "cua-driver__set_value",
        toolCallId: "set-substring",
        args: { app: "Safari", on: "field", value: "锦" },
      }),
      toolEvent({
        runId: "run-substring-value",
        phase: "result",
        name: "cua-driver__set_value",
        toolCallId: "set-substring",
        isError: false,
      }),
      toolEvent({
        runId: "run-substring-value",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-substring",
        args: { app_target: "Safari" },
      }),
      toolEvent({
        runId: "run-substring-value",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "inspect-substring",
        isError: false,
        result: { elements: [{ element_id: "field", value: "旧锦鲤" }] },
      }),
      toolEvent({
        runId: "run-mismatched-verification",
        phase: "start",
        name: "cua-driver__set_value",
        toolCallId: "set-mismatch",
        args: { app: "Notepad", element_index: 3, value: "锦鲤" },
      }),
      toolEvent({
        runId: "run-mismatched-verification",
        phase: "result",
        name: "cua-driver__set_value",
        toolCallId: "set-mismatch",
        isError: false,
        result: {
          action: {
            verification: {
              state: "verified",
              property: "value",
              expected: "完全不同",
            },
          },
        },
      }),
      toolEvent({
        runId: "run-missing-verification-element",
        phase: "start",
        name: "cua-driver__set_value",
        toolCallId: "set-missing-element",
        args: { app: "Notepad", element_index: 3, value: "hello" },
      }),
      toolEvent({
        runId: "run-missing-verification-element",
        phase: "result",
        name: "cua-driver__set_value",
        toolCallId: "set-missing-element",
        isError: false,
        result: {
          action: {
            verification: {
              state: "verified",
              property: "value",
              expected: "hello",
            },
          },
        },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-substring-value")).not.toBeNull();
    expect(guard.finalFailureFor("run-mismatched-verification")).not.toBeNull();
    expect(
      guard.finalFailureFor("run-missing-verification-element"),
    ).not.toBeNull();
  });

  it("does not treat CUA session lifecycle calls as UI mutations", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const [index, name] of [
      "cua-driver__start_session",
      "cua-driver__escalate_session",
      "cua-driver__end_session",
    ].entries()) {
      guard.observeAgentEvent(
        toolEvent({
          runId: "run-7",
          phase: "start",
          name,
          toolCallId: `lifecycle-${index}`,
          args: { session_id: "session-7" },
        }),
      );
      guard.observeAgentEvent(
        toolEvent({
          runId: "run-7",
          phase: "result",
          name,
          toolCallId: `lifecycle-${index}`,
          isError: false,
        }),
      );
    }

    expect(guard.finalFailureFor("run-7")).toBeNull();
  });

  it("keeps targetless frontmost actions unverified", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-8",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-8",
        args: { x: 100, y: 120 },
      }),
      toolEvent({
        runId: "run-8",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-8",
        isError: false,
      }),
      toolEvent({
        runId: "run-8",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-8",
        args: { app_target: "frontmost" },
      }),
      toolEvent({
        runId: "run-8",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-8",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-8")).not.toBeNull();
  });

  it("keeps actions in separate windows independently pending", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-9",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-9a",
        args: { app: "Safari", window_id: 1, x: 100, y: 120 },
      }),
      toolEvent({
        runId: "run-9",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-9a",
        isError: false,
      }),
      toolEvent({
        runId: "run-9",
        phase: "start",
        name: "cua-driver__click",
        toolCallId: "click-9b",
        args: { app: "Safari", window_id: 2, x: 200, y: 220 },
      }),
      toolEvent({
        runId: "run-9",
        phase: "result",
        name: "cua-driver__click",
        toolCallId: "click-9b",
        isError: false,
      }),
      toolEvent({
        runId: "run-9",
        phase: "start",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-9",
        args: { app: "Safari", window_id: 2 },
      }),
      toolEvent({
        runId: "run-9",
        phase: "result",
        name: "cua-driver__get_accessibility_tree",
        toolCallId: "see-9",
        isError: false,
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-9")).not.toBeNull();
  });

  it("accepts Windows launch evidence by returned pid or window id", () => {
    const guard = new LocalAutomationCompletionGuard();
    for (const event of [
      toolEvent({
        runId: "run-10",
        phase: "start",
        name: "cua-driver__launch_app",
        toolCallId: "launch-10",
        args: { name: "Notepad" },
      }),
      toolEvent({
        runId: "run-10",
        phase: "result",
        name: "cua-driver__launch_app",
        toolCallId: "launch-10",
        isError: false,
        result: { pid: 123, windows: [{ window_id: 7 }] },
      }),
      toolEvent({
        runId: "run-10",
        phase: "start",
        name: "cua-driver__get_window_state",
        toolCallId: "state-10",
        args: { pid: 123 },
      }),
      toolEvent({
        runId: "run-10",
        phase: "result",
        name: "cua-driver__get_window_state",
        toolCallId: "state-10",
        isError: false,
        result: { pid: 123, window_id: 7, title: "Untitled - Notepad" },
      }),
    ]) {
      guard.observeAgentEvent(event);
    }

    expect(guard.finalFailureFor("run-10")).toBeNull();
  });

  // Severity split. Actions with no read-back (click and friends) cannot be
  // proven by any provider, so failing the run on them reports successful work
  // as failed. Actions whose evidence the provider could have produced still
  // fail hard. Fixtures below use the real 2026-07-28 provider output.
  describe("severity", () => {
    it("raises only an advisory for a click, which no provider can verify", () => {
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "sev-click",
          phase: "start",
          name: "cua-driver__click",
          toolCallId: "c1",
          args: { pid: 61227, x: 600, y: 400 },
        }),
        toolEvent({
          runId: "sev-click",
          phase: "result",
          name: "cua-driver__click",
          toolCallId: "c1",
          isError: false,
          // Real cua-driver 0.12.6 macOS output.
          result: {
            content: [
              { type: "text", text: "\u2705 Posted click to pid 61227" },
            ],
            structuredContent: {
              effect: "unverifiable",
              path: "cgevent",
              verified: false,
            },
          },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor("sev-click")?.severity).toBe("advisory");
    });

    it("links a launch to later work addressed by pid, from a text-only result", () => {
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "sev-launch",
          phase: "start",
          name: "cua-driver__launch_app",
          toolCallId: "l1",
          args: { name: "Calculator" },
        }),
        toolEvent({
          runId: "sev-launch",
          phase: "result",
          name: "cua-driver__launch_app",
          toolCallId: "l1",
          isError: false,
          // Real cua-driver output. Tool results arrive as text, so the pid
          // must be recovered from the wording or the launch can never be
          // matched against work addressed by pid — which failed the whole run.
          result: {
            content: [
              {
                type: "text",
                text: "Launched \u8ba1\u7b97\u5668 (pid 15242) in background.",
              },
            ],
          },
        }),
        toolEvent({
          runId: "sev-launch",
          phase: "start",
          name: "cua-driver__get_window_state",
          toolCallId: "o1",
          args: { pid: 15242, window_id: 20905 },
        }),
        toolEvent({
          runId: "sev-launch",
          phase: "result",
          name: "cua-driver__get_window_state",
          toolCallId: "o1",
          isError: false,
          result: { pid: 15242 },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor("sev-launch")).toBeNull();
    });

    it("keeps an unread-back type a hard failure even though the provider cannot bind it to an element", () => {
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "sev-type",
          phase: "start",
          name: "cua-driver__type_text",
          toolCallId: "t1",
          args: { app: "\u98de\u4e66", text: "\u9526\u9ca4" },
        }),
        toolEvent({
          runId: "sev-type",
          phase: "result",
          name: "cua-driver__type_text",
          toolCallId: "t1",
          isError: false,
          result: { content: [{ type: "text", text: "[ok] Typed" }] },
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor("sev-type")?.severity).toBe("error");
    });

    it("keeps a failed click a hard failure despite its action class", () => {
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "sev-failed",
          phase: "start",
          name: "cua-driver__click",
          toolCallId: "f1",
          args: { app: "Safari", on: "submit" },
        }),
        toolEvent({
          runId: "sev-failed",
          phase: "result",
          name: "cua-driver__click",
          toolCallId: "f1",
          isError: true,
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor("sev-failed")?.severity).toBe("error");
    });

    it("keeps an in-flight click a hard failure because it may never have been delivered", () => {
      const guard = new LocalAutomationCompletionGuard();
      guard.observeAgentEvent(
        toolEvent({
          runId: "sev-inflight",
          phase: "start",
          name: "cua-driver__click",
          toolCallId: "i1",
          args: { app: "Safari", on: "submit" },
        }),
      );

      expect(guard.finalFailureFor("sev-inflight")?.severity).toBe("error");
    });

    it("downgrades a mixed run to a hard failure when any action had obtainable evidence", () => {
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "sev-mixed",
          phase: "start",
          name: "cua-driver__click",
          toolCallId: "m1",
          args: { app: "Safari", on: "submit" },
        }),
        toolEvent({
          runId: "sev-mixed",
          phase: "result",
          name: "cua-driver__click",
          toolCallId: "m1",
          isError: false,
        }),
        toolEvent({
          runId: "sev-mixed",
          phase: "start",
          name: "cua-driver__set_value",
          toolCallId: "m2",
          args: { app: "Safari", on: "field", value: "x" },
        }),
        toolEvent({
          runId: "sev-mixed",
          phase: "result",
          name: "cua-driver__set_value",
          toolCallId: "m2",
          isError: false,
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      expect(guard.finalFailureFor("sev-mixed")?.severity).toBe("error");
    });

    it("names the action whose evidence is missing, without echoing its params", () => {
      // The generic verdict alone reads as a contradiction — the transcript
      // shows a success story and the reply doubts it without saying which
      // step. The lived case: set_value succeeded, the read-back checked a
      // window title instead of the field, and the user was told "unconfirmed"
      // with no pointer to why.
      const guard = new LocalAutomationCompletionGuard();
      for (const event of [
        toolEvent({
          runId: "named-gap",
          phase: "start",
          name: "cua-driver__set_value",
          toolCallId: "sv-1",
          args: { element_index: 3, value: "世界杯" },
        }),
        toolEvent({
          runId: "named-gap",
          phase: "result",
          name: "cua-driver__set_value",
          toolCallId: "sv-1",
          isError: false,
        }),
      ]) {
        guard.observeAgentEvent(event);
      }

      const failure = guard.finalFailureFor("named-gap");
      expect(failure?.errorMessage).toContain("cua-driver__set_value");
      expect(failure?.errorMessage).toContain("读回确认");
      // Params may carry the user's typed text; it must never surface.
      expect(failure?.errorMessage).not.toContain("世界杯");
    });
  });
});
