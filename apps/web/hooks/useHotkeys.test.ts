// @vitest-environment jsdom
import { renderHook, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useHotkeys } from "./useHotkeys";

function fireKey(
  key: string,
  target?: EventTarget,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
) {
  const evt = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  (target ?? window).dispatchEvent(evt);
  return evt;
}

describe("useHotkeys", () => {
  beforeEach(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  afterEach(() => {
    cleanup();
  });

  it("invokes handler for a single key", () => {
    const j = vi.fn();
    renderHook(() => useHotkeys({ j }));
    fireKey("j");
    expect(j).toHaveBeenCalledTimes(1);
  });

  it("prevents default when key is handled", () => {
    renderHook(() => useHotkeys({ j: () => {} }));
    const evt = fireKey("j");
    expect(evt.defaultPrevented).toBe(true);
  });

  it("is case-insensitive for letter keys", () => {
    const j = vi.fn();
    renderHook(() => useHotkeys({ j }));
    fireKey("J");
    expect(j).toHaveBeenCalledTimes(1);
  });

  it("does not fire when focus is on an input", () => {
    const j = vi.fn();
    renderHook(() => useHotkeys({ j }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireKey("j", input);
    expect(j).not.toHaveBeenCalled();
    input.remove();
  });

  it("still fires alwaysActiveKeys even inside inputs", () => {
    const help = vi.fn();
    renderHook(() => useHotkeys({ "?": help }, { alwaysActiveKeys: ["?"] }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireKey("?", input);
    expect(help).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("ignores keys when ctrl/meta/alt are held", () => {
    const j = vi.fn();
    renderHook(() => useHotkeys({ j }));
    fireKey("j", undefined, { ctrlKey: true });
    fireKey("j", undefined, { metaKey: true });
    fireKey("j", undefined, { altKey: true });
    expect(j).not.toHaveBeenCalled();
  });

  it("fires two-key sequence g g within window", () => {
    const gg = vi.fn();
    renderHook(() => useHotkeys({ "g g": gg }));
    fireKey("g");
    fireKey("g");
    expect(gg).toHaveBeenCalledTimes(1);
  });

  it("does not fire sequence if window elapsed", () => {
    const gg = vi.fn();
    renderHook(() => useHotkeys({ "g g": gg }, { sequenceWindowMs: 10 }));
    fireKey("g");
    const origNow = Date.now;
    Date.now = () => origNow() + 1000;
    try {
      fireKey("g");
    } finally {
      Date.now = origNow;
    }
    expect(gg).not.toHaveBeenCalled();
  });

  it("unregisters listener when enabled flips to false", () => {
    const j = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useHotkeys({ j }, { enabled }),
      { initialProps: { enabled: true } },
    );
    fireKey("j");
    expect(j).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    fireKey("j");
    expect(j).toHaveBeenCalledTimes(1);
  });
});
