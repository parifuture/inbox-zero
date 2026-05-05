/**
 * EL-385 — Pure mapping/parsing helpers for seed-from-gmail-mirror.
 *
 * Kept separate from the script entry point so they can be unit-tested
 * without a live gmail-mirror SQLite file, Postgres, or Prisma client.
 */

import type { SenderAction } from "@/generated/prisma/enums";
import {
  canonicalizeSender as canonicalizeSenderImpl,
  canonicalizeSenderOrThrow as canonicalizeSenderOrThrowImpl,
} from "@/utils/sender-decision";
import { extractDomainFromEmail } from "@/utils/email";

export const canonicalizeSender = canonicalizeSenderImpl;
export const canonicalizeSenderOrThrow = canonicalizeSenderOrThrowImpl;

export function extractDomainFromEmailSafe(email: string): string {
  try {
    const d = extractDomainFromEmail(email);
    return d ? d.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** One row as returned by gmail-mirror `emails` aggregation. */
export type MirrorSenderRow = {
  fromAddress: string;
  messageCount: number;
  firstSeenEpoch: number | null; // seconds
  lastSeenEpoch: number | null; // seconds
};

/** One sender_truth row from sidecar Postgres. */
export type SidecarTruthRow = {
  senderEmail: string; // canonicalized
  category: string | null;
  action: string | null;
  source: string | null;
};

/**
 * Map a sidecar truth row to a fork `SenderAction`.
 *
 * Rules (same semantics as `seed-sender-decision.ts`'s `mapSidecarAction`):
 *
 *   - action="trash"                                  -> auto_trash
 *   - category in {bulk, marketing, promotional}      -> auto_trash
 *   - category in {transactional, receipts,
 *                  sent-history}
 *     or action in {archive, inbox, keep}             -> always_keep
 *   - everything else                                 -> review
 *
 * Pure / deterministic so it's safe to unit-test.
 */
export function mapSidecarAction(row: SidecarTruthRow): SenderAction {
  const action = (row.action ?? "").toLowerCase();
  const category = (row.category ?? "").toLowerCase();

  if (action === "trash") return "auto_trash";

  if (
    category === "bulk" ||
    category === "marketing" ||
    category === "promotional"
  ) {
    return "auto_trash";
  }

  if (
    category === "transactional" ||
    category === "receipts" ||
    category === "sent-history" ||
    action === "archive" ||
    action === "inbox" ||
    action === "keep"
  ) {
    return "always_keep";
  }

  return "review";
}

/**
 * Classify a gmail-mirror sender aggregate into a `SenderAction`.
 *
 * v1 policy: use the sidecar truth row if present; otherwise default to
 * `review` (never `auto_trash` from volume alone). Pure.
 */
export function classifyMirrorSender(
  row: MirrorSenderRow,
  sidecarLookup?: Map<string, SidecarTruthRow> | null,
): {
  action: SenderAction;
  reason: "sidecar" | "review-default";
  truth: SidecarTruthRow | null;
} {
  const canonical = canonicalizeSender(row.fromAddress);
  const truth =
    canonical && sidecarLookup ? (sidecarLookup.get(canonical) ?? null) : null;
  if (truth) {
    return { action: mapSidecarAction(truth), reason: "sidecar", truth };
  }
  return { action: "review", reason: "review-default", truth: null };
}

/**
 * Minimal argv parser. Avoids adding a new dep just for this script.
 *
 * Supports: --flag  /  --flag value  /  --flag=value.
 * Unknown flags become booleans when bare, strings when a value follows.
 */
export function parseArgs(
  argv: string[],
  spec: {
    string?: string[];
    number?: string[];
    boolean?: string[];
  } = {},
): Record<string, string | number | boolean> {
  const stringKeys = new Set(spec.string ?? []);
  const numberKeys = new Set(spec.number ?? []);
  const booleanKeys = new Set(spec.boolean ?? []);

  const out: Record<string, string | number | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    let key: string;
    let value: string | undefined;
    const eqIdx = tok.indexOf("=");
    if (eqIdx >= 0) {
      key = tok.slice(2, eqIdx);
      value = tok.slice(eqIdx + 1);
    } else {
      key = tok.slice(2);
      // Pull next token as value unless it looks like another flag or the
      // key is a known boolean.
      const next = argv[i + 1];
      if (!booleanKeys.has(key) && next != null && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }

    if (booleanKeys.has(key)) {
      out[key] = value == null ? true : value !== "false" && value !== "0";
    } else if (numberKeys.has(key)) {
      const n = value == null ? Number.NaN : Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`--${key} requires a number; got "${value ?? ""}"`);
      }
      out[key] = n;
    } else if (stringKeys.has(key)) {
      if (value == null) {
        throw new Error(`--${key} requires a value`);
      }
      out[key] = value;
    } else {
      // Unknown: preserve as string/boolean for debugging.
      out[key] = value == null ? true : value;
    }
  }

  return out;
}
