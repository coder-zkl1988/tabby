import { describe, expect, it } from "vitest";
import { parseKeyChord } from "../../apps/desktop/main/services/embedded-browser-cdp";

/**
 * What browser_press accepts. The agent writes keys the way keyboard docs do
 * ("Enter", "Shift+Tab"); the parser turns them into the CDP fields Chromium
 * needs, and refuses anything it cannot express instead of sending an event
 * the page would ignore.
 */
describe("parseKeyChord", () => {
  it("maps named keys with the text Chromium expects", () => {
    expect(parseKeyChord("Enter")).toEqual({
      definition: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      modifiers: 0,
    });
    expect(parseKeyChord("escape")?.definition.keyCode).toBe(27);
    expect(parseKeyChord("ArrowDown")?.definition.code).toBe("ArrowDown");
    expect(parseKeyChord("Tab")?.definition.text).toBeUndefined();
  });

  it("maps single characters to their key codes", () => {
    expect(parseKeyChord("a")).toEqual({
      definition: { key: "a", code: "KeyA", keyCode: 65, text: "a" },
      modifiers: 0,
    });
    expect(parseKeyChord("7")?.definition).toEqual({
      key: "7",
      code: "Digit7",
      keyCode: 55,
      text: "7",
    });
    // Punctuation still types, just without a physical key code.
    expect(parseKeyChord("?")?.definition).toEqual({
      key: "?",
      code: "",
      keyCode: 0,
      text: "?",
    });
  });

  it("folds modifiers into the CDP bitmask and shifts characters", () => {
    expect(parseKeyChord("Shift+Tab")?.modifiers).toBe(8);
    expect(parseKeyChord("Control+A")?.modifiers).toBe(2);
    expect(parseKeyChord("Cmd+c")?.modifiers).toBe(4);
    expect(parseKeyChord("Alt+Shift+ArrowDown")?.modifiers).toBe(9);
    expect(parseKeyChord("shift+a")?.definition.key).toBe("A");
  });

  it("refuses what it cannot express", () => {
    expect(parseKeyChord("")).toBeNull();
    expect(parseKeyChord("Bogus")).toBeNull();
    expect(parseKeyChord("Hyper+a")).toBeNull();
    expect(parseKeyChord("ab")).toBeNull();
  });
});
