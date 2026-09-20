/**
 * @vitest-environment jsdom
 *
 * inline-a2ui-host.test.tsx — regression guard for the pin control.
 *
 * The first cut pinned from an effect that depended on `onPin` and `messages`.
 * The transcript renderer rebuilds both every render and pinning re-renders the
 * tree (canvas store setState), so the effect re-fired forever and React threw
 * "Maximum update depth exceeded", taking the desktop app down. These tests pin
 * the invariant: pinning is idempotent per surface, whatever the parent does
 * with identities.
 */

import { InlineA2UIHost } from "@/components/inline-a2ui-host";
import type { A2UIMessage } from "@/lib/a2ui";
import {
  resetPinnedTypesForTests,
  setTypePinned,
} from "@/lib/a2ui/a2ui-pin-store";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/a2ui", async () => ({
  A2UIRenderer: () => <div data-testid="a2ui-renderer" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? "",
  }),
}));

function surface(type: string, surfaceId = "s1"): A2UIMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId, components: [{ id: "a", type }] },
    } as unknown as A2UIMessage,
  ];
}

/** Click the pin control, failing loudly if the card is not in its pinnable state. */
function clickPin(container: HTMLElement): void {
  const trigger = container.querySelector("[data-a2ui-pin-trigger]");
  if (!trigger) throw new Error("no pin trigger rendered");
  fireEvent.click(trigger);
}

describe("InlineA2UIHost", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPinnedTypesForTests();
  });
  afterEach(cleanup);

  it("pins once per surface even when the parent re-renders with new identities", () => {
    const onPin = vi.fn();
    const view = render(
      <InlineA2UIHost
        messages={surface("XhsOpsRunPlanner")}
        onPin={onPin}
        onA2UIAction={() => undefined}
      />,
    );

    clickPin(view.container);
    expect(onPin).toHaveBeenCalledTimes(1);

    // What the real transcript does on every commit: fresh messages array and a
    // fresh inline callback. This is exactly what looped before.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(
        <InlineA2UIHost
          messages={surface("XhsOpsRunPlanner")}
          onPin={onPin}
          onA2UIAction={() => undefined}
        />,
      );
    }
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("collapses to a pointer once pinned so only one renderer stays live", () => {
    const view = render(
      <InlineA2UIHost messages={surface("XhsOpsDashboard")} onPin={vi.fn()} />,
    );
    expect(view.queryByTestId("a2ui-renderer")).not.toBeNull();

    clickPin(view.container);

    expect(view.queryByTestId("a2ui-renderer")).toBeNull();
    expect(
      view.container.querySelector("[data-a2ui-pinned-pointer]"),
    ).not.toBeNull();
  });

  it("auto-pins a later card whose component type was pinned before", () => {
    const first = render(
      <InlineA2UIHost
        messages={surface("XhsOpsRunPlanner", "p1")}
        onPin={vi.fn()}
      />,
    );
    clickPin(first.container);
    cleanup();

    // A different project: new surfaceId, same component type.
    const onPin = vi.fn();
    const later = render(
      <InlineA2UIHost
        messages={surface("XhsOpsRunPlanner", "xhs-badminton-runplanner")}
        onPin={onPin}
      />,
    );
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(
      later.container.querySelector("[data-a2ui-pinned-pointer]"),
    ).not.toBeNull();
  });

  it("comes back inline when the type is unpinned, and can be pinned again", () => {
    const onPin = vi.fn();
    const messages = surface("XhsOpsRunPlanner");
    const view = render(<InlineA2UIHost messages={messages} onPin={onPin} />);

    clickPin(view.container);
    expect(view.queryByTestId("a2ui-renderer")).toBeNull();
    expect(onPin).toHaveBeenCalledTimes(1);

    // What the panel's unpin button does: clear the remembered type. Wrapped
    // in act() because this store notifies outside React's event loop.
    act(() => setTypePinned("XhsOpsRunPlanner", false));

    // The card is rendered in the transcript again, pin control and all.
    expect(view.queryByTestId("a2ui-renderer")).not.toBeNull();
    expect(
      view.container.querySelector("[data-a2ui-pinned-pointer]"),
    ).toBeNull();

    // Pinning a second time must still work — the idempotence guard that
    // stops the render loop must not swallow a legitimate re-pin.
    clickPin(view.container);
    expect(onPin).toHaveBeenCalledTimes(2);
    expect(view.queryByTestId("a2ui-renderer")).toBeNull();
  });

  it("pins a typeless surface as a one-off without remembering it", () => {
    const onPin = vi.fn();
    const view = render(
      <InlineA2UIHost
        messages={[
          {
            version: "v0.9",
            createSurface: { surfaceId: "s9", components: [] },
          } as unknown as A2UIMessage,
        ]}
        onPin={onPin}
      />,
    );
    clickPin(view.container);
    expect(onPin).toHaveBeenCalledTimes(1);
    // Nothing stable to remember, so the card stays inline.
    expect(view.queryByTestId("a2ui-renderer")).not.toBeNull();
  });
});
