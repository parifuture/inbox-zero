"use client";

import { useEffect, useRef } from "react";

export type HotkeyHandler = (event: KeyboardEvent) => void;

export type HotkeyMap = Record<string, HotkeyHandler>;

// Returns true if the event target is a form field we shouldn't hijack.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // Radix portals set [role="combobox"] / [role="listbox"] on open selects.
  const role = target.getAttribute("role");
  if (role === "combobox" || role === "listbox") return true;
  return false;
}

function eventKey(e: KeyboardEvent): string {
  // Normalise common keys. We only care about simple bare keys plus "?" and "/".
  const k = e.key;
  if (k === "Escape") return "esc";
  if (k === "?") return "?";
  if (k === "/") return "/";
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

export interface UseHotkeysOptions {
  // If true, allow the handler to fire even while focus is inside a typing
  // target. Default false (we bail on inputs/textareas). Certain keys in the
  // "alwaysActiveKeys" set will always fire.
  alwaysActiveKeys?: string[];
  // When false, the listener is not attached. Useful to disable while a modal
  // is open so Escape can be handled by the modal itself, etc.
  enabled?: boolean;
  // If set, only fire when event.target is inside this element. Default: global.
  scopeRef?: React.RefObject<HTMLElement | null>;
  // ms window for a two-key sequence like "g g".
  sequenceWindowMs?: number;
}

/**
 * Minimal, scoped hotkey hook.
 *
 * - Plain keys only — no ctrl/alt/meta combos.
 * - Supports single keys ("j", "k", "/", "?") and one two-key sequence
 *   expressed as a space-separated string ("g g").
 * - Does nothing when focus is inside an input/textarea/select, unless the
 *   key is listed in `alwaysActiveKeys` (e.g. "?" should still open help).
 * - Listener is mounted per-component, not globally — EL-368 wants page-scoped.
 */
export function useHotkeys(map: HotkeyMap, opts: UseHotkeysOptions = {}) {
  const {
    enabled = true,
    sequenceWindowMs = 600,
    scopeRef,
    alwaysActiveKeys = ["?"],
  } = opts;
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    let lastKey: string | null = null;
    let lastKeyAt = 0;

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = eventKey(e);
      const typing = isTypingTarget(e.target);
      const isAlways = alwaysActiveKeys.includes(key);

      // Allow "/" to focus search even if user somewhere else, but not while
      // already typing inside an input.
      if (typing && !isAlways) return;

      if (scopeRef?.current && e.target instanceof Node) {
        if (!scopeRef.current.contains(e.target)) return;
      }

      const now = Date.now();
      const handlers = mapRef.current;

      // Two-key sequence (e.g. "g g").
      if (lastKey && now - lastKeyAt <= sequenceWindowMs) {
        const combo = `${lastKey} ${key}`;
        if (handlers[combo]) {
          e.preventDefault();
          handlers[combo](e);
          lastKey = null;
          return;
        }
      }

      if (handlers[key]) {
        e.preventDefault();
        handlers[key](e);
        lastKey = null;
        return;
      }

      // Remember last key only if it could be the prefix of a known sequence.
      const isPrefix = Object.keys(handlers).some((k) =>
        k.startsWith(`${key} `),
      );
      if (isPrefix) {
        lastKey = key;
        lastKeyAt = now;
      } else {
        lastKey = null;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, sequenceWindowMs, scopeRef, alwaysActiveKeys]);
}
