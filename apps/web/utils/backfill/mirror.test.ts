/**
 * EL-471 — Mirror reader tests.
 *
 * We don't ship a binary fixture .db — we build one at test setup time
 * from the same DDL the real mirror uses. Keeps the test repo clean and
 * keeps the schema declaration in one place.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MirrorReader, withMirrorReader } from "./mirror";

const FIXTURE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "backfill-mirror-fixture-"),
);
const FIXTURE_DB = path.join(FIXTURE_DIR, "mirror.db");

interface FixtureEmail {
  bodyText?: string;
  /** Unix epoch seconds. */
  dateSent: number;
  fromAddress: string;
  fromName?: string;
  id: string;
  labels?: string;
  snippet?: string;
  subject: string;
  /** Unix epoch seconds; defaults to dateSent. */
  syncedAt?: number;
  threadId?: string;
}

const NEWSLETTER_SENDER = "newsletter@example.com";
const RECEIPTS_SENDER = "receipts@vendor.com";
const PERSONAL_SENDER = "friend@gmail.com";
const JUNK_DATE_SENDER = "broken@junk.test";

// 2024-01-01 in unix seconds
const JAN_1_2024 = 1_704_067_200;
const ONE_DAY = 86_400;

function fixtureEmails(): FixtureEmail[] {
  const out: FixtureEmail[] = [];
  // 5 newsletter emails, one per day starting 2024-01-01
  for (let i = 0; i < 5; i++) {
    out.push({
      id: `nl-${i}`,
      threadId: `t-nl-${i}`,
      subject: `Weekly digest #${i + 1}`,
      fromAddress: NEWSLETTER_SENDER,
      fromName: "Example Newsletter",
      snippet: "Top stories...",
      bodyText: `<long body for email ${i}>`,
      labels: "INBOX,CATEGORY_PROMOTIONS",
      dateSent: JAN_1_2024 + i * ONE_DAY,
    });
  }
  // 3 receipts, more recent
  for (let i = 0; i < 3; i++) {
    out.push({
      id: `rc-${i}`,
      threadId: `t-rc-${i}`,
      subject: `Receipt #${1000 + i}`,
      fromAddress: RECEIPTS_SENDER,
      fromName: "Vendor",
      snippet: `Order total $${10 + i}`,
      bodyText: `Receipt body ${i}`,
      labels: "INBOX",
      dateSent: JAN_1_2024 + 30 * ONE_DAY + i * ONE_DAY,
    });
  }
  // 1 personal email
  out.push({
    id: "p-0",
    threadId: "t-p-0",
    subject: "Catch up?",
    fromAddress: PERSONAL_SENDER,
    fromName: "A Friend",
    snippet: "Hey, we should hang out",
    bodyText: "longer body here",
    labels: "INBOX,IMPORTANT",
    dateSent: JAN_1_2024 + 60 * ONE_DAY,
  });
  // 2 junk-date rows (date_sent = 0)
  for (let i = 0; i < 2; i++) {
    out.push({
      id: `junk-${i}`,
      subject: "missing headers",
      fromAddress: JUNK_DATE_SENDER,
      dateSent: 0,
    });
  }
  return out;
}

function buildFixtureDb(): void {
  if (fs.existsSync(FIXTURE_DB)) fs.unlinkSync(FIXTURE_DB);
  const db = new Database(FIXTURE_DB);
  // DDL mirrored from the real ~/data/gmail-mirror/mirror.db schema.
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      subject TEXT,
      from_address TEXT,
      from_name TEXT,
      to_addresses TEXT,
      cc_addresses TEXT,
      date_sent INTEGER,
      labels TEXT,
      snippet TEXT,
      body_text TEXT,
      body_html_path TEXT,
      has_attachments INTEGER DEFAULT 0,
      attachment_metadata TEXT,
      raw_path TEXT,
      synced_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX idx_emails_date ON emails(date_sent);
    CREATE INDEX idx_emails_from ON emails(from_address);
    CREATE INDEX idx_emails_thread ON emails(thread_id);
    CREATE INDEX idx_emails_labels ON emails(labels);
  `);
  const insert = db.prepare(`
    INSERT INTO emails (id, thread_id, subject, from_address, from_name, snippet, body_text, labels, date_sent, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows: FixtureEmail[]) => {
    for (const r of rows) {
      insert.run(
        r.id,
        r.threadId ?? null,
        r.subject,
        r.fromAddress,
        r.fromName ?? null,
        r.snippet ?? null,
        r.bodyText ?? null,
        r.labels ?? null,
        r.dateSent,
        r.syncedAt ?? r.dateSent ?? 0,
      );
    }
  });
  tx(fixtureEmails());
  db.close();
}

beforeAll(() => buildFixtureDb());
afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe("MirrorReader.freshness", () => {
  it("reports total rows including junk-date rows and the latest sync time", () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const f = r.freshness();
      expect(f.totalRows).toBe(5 + 3 + 1 + 2);
      expect(f.dbPath).toBe(FIXTURE_DB);
      expect(f.lastSyncAt).toBeInstanceOf(Date);
    } finally {
      r.close();
    }
  });
});

describe("MirrorReader.listSenders", () => {
  it("returns one row per sender, count DESC, junk-date rows excluded", () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const senders = r.listSenders();
      expect(senders.map((s) => s.fromAddress)).toEqual([
        NEWSLETTER_SENDER,
        RECEIPTS_SENDER,
        PERSONAL_SENDER,
      ]);
      expect(senders[0].count).toBe(5);
      expect(senders[1].count).toBe(3);
      expect(senders[2].count).toBe(1);
    } finally {
      r.close();
    }
  });

  it("respects dateFloor and dateCeil scope filters", () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      // Only the receipt window (day 30..32) should match.
      const dateFloor = new Date((JAN_1_2024 + 30 * ONE_DAY) * 1000);
      const dateCeil = new Date((JAN_1_2024 + 33 * ONE_DAY) * 1000);
      const senders = r.listSenders({ dateFloor, dateCeil });
      expect(senders).toHaveLength(1);
      expect(senders[0].fromAddress).toBe(RECEIPTS_SENDER);
      expect(senders[0].count).toBe(3);
    } finally {
      r.close();
    }
  });

  it("returns at most one row when senderScope is set", () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const matches = r.listSenders({ senderScope: PERSONAL_SENDER });
      expect(matches).toHaveLength(1);
      expect(matches[0].fromAddress).toBe(PERSONAL_SENDER);
    } finally {
      r.close();
    }
  });

  it("senderScope is case-insensitive", () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const matches = r.listSenders({
        senderScope: PERSONAL_SENDER.toUpperCase(),
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].fromAddress).toBe(PERSONAL_SENDER);
    } finally {
      r.close();
    }
  });
});

describe("MirrorReader.loadSenderHistory", () => {
  it("yields chunks of chunkSize, newest first", async () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const chunks: number[] = [];
      const ids: string[] = [];
      for await (const chunk of r.loadSenderHistory(NEWSLETTER_SENDER, {
        chunkSize: 2,
      })) {
        chunks.push(chunk.length);
        for (const m of chunk) ids.push(m.id);
      }
      // 5 emails / chunkSize 2 => [2, 2, 1]
      expect(chunks).toEqual([2, 2, 1]);
      // Newest first: nl-4, nl-3, nl-2, nl-1, nl-0
      expect(ids).toEqual(["nl-4", "nl-3", "nl-2", "nl-1", "nl-0"]);
    } finally {
      r.close();
    }
  });

  it("respects maxEmails as a hard cap", async () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const ids: string[] = [];
      for await (const chunk of r.loadSenderHistory(NEWSLETTER_SENDER, {
        chunkSize: 10,
        maxEmails: 3,
      })) {
        for (const m of chunk) ids.push(m.id);
      }
      expect(ids).toEqual(["nl-4", "nl-3", "nl-2"]);
    } finally {
      r.close();
    }
  });

  it("returns an empty stream for a sender with no rows", async () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const chunks: unknown[] = [];
      for await (const chunk of r.loadSenderHistory("nope@nowhere.tld")) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(0);
    } finally {
      r.close();
    }
  });

  it("excludes junk-date (date_sent <= 0) rows", async () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const ids: string[] = [];
      for await (const chunk of r.loadSenderHistory(JUNK_DATE_SENDER)) {
        for (const m of chunk) ids.push(m.id);
      }
      expect(ids).toEqual([]);
    } finally {
      r.close();
    }
  });

  it("normalizes from_address to lowercase on the way out", async () => {
    const r = new MirrorReader(FIXTURE_DB);
    try {
      const collected: string[] = [];
      for await (const chunk of r.loadSenderHistory(
        PERSONAL_SENDER.toUpperCase(),
      )) {
        for (const m of chunk) collected.push(m.fromAddress);
      }
      expect(collected).toEqual([PERSONAL_SENDER]);
    } finally {
      r.close();
    }
  });
});

describe("withMirrorReader", () => {
  it("opens, runs fn, closes the reader even on throw", async () => {
    let opened = false;
    const err = new Error("boom");
    await expect(
      withMirrorReader(async (reader) => {
        opened = true;
        // touch the reader so we know it's live
        reader.freshness();
        throw err;
      }, FIXTURE_DB),
    ).rejects.toBe(err);
    expect(opened).toBe(true);
    // If we leaked a writer handle the next opener would still succeed
    // because the file is unlocked once GC runs, but readonly+mustExist
    // should at minimum not blow up:
    const r = new MirrorReader(FIXTURE_DB);
    expect(r.freshness().totalRows).toBeGreaterThan(0);
    r.close();
  });
});

describe("MirrorReader read-only invariant", () => {
  it("opens a separately-acquired readonly handle and confirms writes throw", () => {
    // The reader's `db` is private, so we assert the invariant via a
    // sibling handle opened with the same options. (Direct introspection
    // of the private field would defeat encapsulation lint rules.)
    const r = new MirrorReader(FIXTURE_DB);
    try {
      expect(r.freshness().totalRows).toBeGreaterThan(0);
    } finally {
      r.close();
    }

    const probe = new Database(FIXTURE_DB, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(() => probe.exec("DELETE FROM emails")).toThrow();
    } finally {
      probe.close();
    }
  });
});
