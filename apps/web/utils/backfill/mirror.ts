/**
 * EL-471 — Mirror reader for the smart historical backfill.
 *
 * Read-only access to the local Gmail SQLite mirror (default
 * `~/data/gmail-mirror/mirror.db`, ~100k rows, FTS5-indexed).
 *
 * Design notes:
 * - Opens the DB read-only and with `fileMustExist: true` so we never
 *   silently create an empty mirror file.
 * - All queries use prepared statements; the module is safe to import
 *   from request handlers / workers (better-sqlite3 is synchronous and
 *   blazing fast — a sender shortlist over 100k rows is sub-millisecond).
 * - We treat the file path as configuration, not a constant — the
 *   worker can be pointed at a fixture DB during tests.
 * - We deliberately filter out the `date_sent <= 0` junk rows. There are
 *   a handful in real mirrors (rfc 2822 dates that failed to parse) and
 *   they would otherwise show up as "1970" senders that confuse the LLM.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface MirrorEmailRow {
  /**
   * Plain-text body. May be quite large; the LLM evaluator should
   * truncate at the prompt-construction layer, not here.
   */
  bodyText: string;
  /** Wall-clock send time. */
  dateSent: Date;
  /** Lowercased canonical sender email. */
  fromAddress: string;
  /** Sender display name as seen on the wire. */
  fromName: string | null;
  /** Gmail internal message id (PK in the mirror). */
  id: string;
  /**
   * Comma-joined Gmail label list as the mirror sees it. Useful for
   * the LLM to know whether something is already INBOX vs Archive.
   */
  labels: string;
  /** Snippet (Gmail's preview text). */
  snippet: string;
  /** Subject line (may be empty string for senderless service mail). */
  subject: string;
  /** Gmail thread id; may be null for very old / corrupt rows. */
  threadId: string | null;
}

export interface SenderShortlistRow {
  /** Number of mirrored emails from this sender within scope. */
  count: number;
  /** Lowercased canonical sender email. */
  fromAddress: string;
  /** Latest in-scope email date for this sender. */
  newest: Date;
  /** Earliest in-scope email date for this sender. */
  oldest: Date;
}

export interface MirrorFreshness {
  /** Path of the DB the reader is bound to (handy for diagnostics / UI banner). */
  dbPath: string;
  /** Most recent `synced_at` across all rows. */
  lastSyncAt: Date | null;
  /** Total mirrored rows (including junk-date rows). */
  totalRows: number;
}

export interface ListSendersOptions {
  /** Only include emails strictly before this date. Lets us bound runs. */
  dateCeil?: Date;
  /** Only include emails on or after this date. */
  dateFloor?: Date;
  /** Hard cap on returned senders — defaults to no cap. */
  limit?: number;
  /**
   * Single-sender filter (lowercased email). When set, the result is at
   * most one row — we still return an array so callers don't need to
   * special-case the single-sender path.
   */
  senderScope?: string;
}

export interface LoadSenderHistoryOptions {
  /** Number of emails per yielded chunk; defaults to 200. */
  chunkSize?: number;
  /** Only include emails strictly before this date. */
  dateCeil?: Date;
  /** Only include emails on or after this date. */
  dateFloor?: Date;
  /**
   * Hard cap on total emails yielded for this sender. Useful as a
   * defensive bound for power-senders (e.g. mail-list@... with 10k
   * rows that would otherwise burn LLM budget).
   */
  maxEmails?: number;
}

/**
 * Resolve `~/...` style paths to absolute paths.
 * Kept tiny on purpose — we don't want a yargs-style env loader here.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Default mirror location. Override via the `BACKFILL_MIRROR_DB` env var. */
export function defaultMirrorPath(): string {
  return expandHome(
    process.env.BACKFILL_MIRROR_DB ?? "~/data/gmail-mirror/mirror.db",
  );
}

export class MirrorReader {
  private readonly db: DatabaseType;
  readonly dbPath: string;

  constructor(dbPath: string = defaultMirrorPath()) {
    this.dbPath = dbPath;
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Mirror DB not found at ${dbPath}`);
    }
    // readonly + fileMustExist: belt-and-braces against accidentally
    // creating a writeable handle that could mutate the source of truth.
    this.db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    // Make the few DDL-ish settings explicit so the reader behaves the
    // same regardless of which user opened the DB last.
    this.db.pragma("query_only = ON");
  }

  close(): void {
    this.db.close();
  }

  freshness(): MirrorFreshness {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total, MAX(synced_at) AS last_sync FROM emails",
      )
      .get() as { total: number; last_sync: number | null };
    return {
      totalRows: row.total,
      lastSyncAt: row.last_sync ? new Date(row.last_sync * 1000) : null,
      dbPath: this.dbPath,
    };
  }

  /**
   * Return the distinct senders that have at least one in-scope email.
   * Sorted by count DESC so the worker hits high-volume senders first
   * (where bulk archive/trash decisions get the most leverage per LLM
   * call).
   */
  listSenders(opts: ListSendersOptions = {}): SenderShortlistRow[] {
    const conditions: string[] = ["date_sent > 0"];
    const params: (number | string)[] = [];

    if (opts.dateFloor) {
      conditions.push("date_sent >= ?");
      params.push(Math.floor(opts.dateFloor.getTime() / 1000));
    }
    if (opts.dateCeil) {
      conditions.push("date_sent < ?");
      params.push(Math.floor(opts.dateCeil.getTime() / 1000));
    }
    if (opts.senderScope) {
      conditions.push("LOWER(from_address) = ?");
      params.push(opts.senderScope.toLowerCase());
    }

    const limitClause =
      typeof opts.limit === "number" && opts.limit > 0
        ? ` LIMIT ${Math.floor(opts.limit)}`
        : "";

    const sql = `
      SELECT LOWER(from_address) AS from_address,
             COUNT(*)            AS count,
             MIN(date_sent)      AS oldest,
             MAX(date_sent)      AS newest
      FROM emails
      WHERE ${conditions.join(" AND ")}
      GROUP BY LOWER(from_address)
      ORDER BY count DESC, from_address ASC${limitClause}
    `;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      from_address: string;
      count: number;
      oldest: number;
      newest: number;
    }>;
    return rows.map((r) => ({
      fromAddress: r.from_address,
      count: r.count,
      oldest: new Date(r.oldest * 1000),
      newest: new Date(r.newest * 1000),
    }));
  }

  /**
   * Yield a sender's history as chunks of `chunkSize` rows, newest
   * first. Async generator so callers can `for await` and stream
   * decisions to Postgres without building a giant intermediate array
   * for power-senders.
   *
   * Technically synchronous under the hood (better-sqlite3 is sync),
   * but expressed async so the caller can interleave LLM calls without
   * blocking the event loop on a single huge SELECT.
   */
  async *loadSenderHistory(
    sender: string,
    opts: LoadSenderHistoryOptions = {},
  ): AsyncGenerator<MirrorEmailRow[], void, void> {
    const chunkSize = opts.chunkSize ?? 200;
    const maxEmails = opts.maxEmails ?? Number.POSITIVE_INFINITY;
    const conditions: string[] = ["LOWER(from_address) = ?", "date_sent > 0"];
    const params: (number | string)[] = [sender.toLowerCase()];
    if (opts.dateFloor) {
      conditions.push("date_sent >= ?");
      params.push(Math.floor(opts.dateFloor.getTime() / 1000));
    }
    if (opts.dateCeil) {
      conditions.push("date_sent < ?");
      params.push(Math.floor(opts.dateCeil.getTime() / 1000));
    }

    // Cursor-style pagination on (date_sent DESC, id DESC) to keep
    // chunks stable even when two emails share a second-resolution
    // timestamp (which happens with bulk newsletter sends).
    let lastDate: number | null = null;
    let lastId: string | null = null;
    let yielded = 0;

    while (yielded < maxEmails) {
      const cursor: string[] = [];
      const cursorParams: (number | string)[] = [];
      if (lastDate !== null && lastId !== null) {
        cursor.push("(date_sent < ? OR (date_sent = ? AND id < ?))");
        cursorParams.push(lastDate, lastDate, lastId);
      }

      const remaining = Math.min(chunkSize, maxEmails - yielded);
      const sql = `
        SELECT id, thread_id AS threadId, subject, from_address AS fromAddress,
               from_name AS fromName, snippet, body_text AS bodyText,
               labels, date_sent AS dateSent
        FROM emails
        WHERE ${[...conditions, ...cursor].join(" AND ")}
        ORDER BY date_sent DESC, id DESC
        LIMIT ${remaining}
      `;
      const rows = this.db
        .prepare(sql)
        .all(...params, ...cursorParams) as Array<{
        id: string;
        threadId: string | null;
        subject: string | null;
        fromAddress: string;
        fromName: string | null;
        snippet: string | null;
        bodyText: string | null;
        labels: string | null;
        dateSent: number;
      }>;
      if (rows.length === 0) return;

      const mapped: MirrorEmailRow[] = rows.map((r) => ({
        id: r.id,
        threadId: r.threadId,
        subject: r.subject ?? "",
        fromAddress: r.fromAddress.toLowerCase(),
        fromName: r.fromName,
        snippet: r.snippet ?? "",
        bodyText: r.bodyText ?? "",
        labels: r.labels ?? "",
        dateSent: new Date(r.dateSent * 1000),
      }));

      yielded += mapped.length;
      yield mapped;

      const last = rows[rows.length - 1];
      lastDate = last.dateSent;
      lastId = last.id;

      if (rows.length < remaining) return;
    }
  }
}

/**
 * Convenience helper for one-off reads — opens a reader, runs `fn`,
 * always closes the handle. Use this from request handlers to avoid
 * leaking file descriptors when an error fires mid-query.
 */
export async function withMirrorReader<T>(
  fn: (reader: MirrorReader) => Promise<T> | T,
  dbPath?: string,
): Promise<T> {
  const reader = new MirrorReader(dbPath);
  try {
    return await fn(reader);
  } finally {
    reader.close();
  }
}
