/**
 * EL-472 — Backfill API: mirror freshness banner data.
 *
 * GET /api/backfill/mirror
 * Returns total mirrored emails + last sync time for the UI banner.
 */

import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { withMirrorReader } from "@/utils/backfill/mirror";

export type BackfillMirrorResponse = {
  totalRows: number;
  lastSyncAt: string | null;
  dbPath: string;
  available: boolean;
  error?: string;
};

export const GET = withEmailAccount(
  "backfill/mirror",
  async (_request) => {
    try {
      const result = await withMirrorReader((reader) => reader.freshness());
      const body: BackfillMirrorResponse = {
        totalRows: result.totalRows,
        lastSyncAt: result.lastSyncAt ? result.lastSyncAt.toISOString() : null,
        dbPath: result.dbPath,
        available: true,
      };
      return NextResponse.json(body);
    } catch (err) {
      // Mirror not present (e.g. self-hosted user without gmail-mirror
      // running). UI should render a graceful "Backfill unavailable"
      // state rather than blowing up.
      const body: BackfillMirrorResponse = {
        totalRows: 0,
        lastSyncAt: null,
        dbPath: "",
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return NextResponse.json(body, { status: 200 });
    }
  },
  { requestTiming: {} },
);
