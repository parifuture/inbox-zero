import { describe, expect, it } from "vitest";
import type { SenderDecision } from "@/generated/prisma/client";
import {
  computeImportDiff,
  exportSenderDecisionsToCsv,
  parseSenderDecisionCsv,
} from "./csv";

type ExistingRow = Pick<SenderDecision, "action" | "source" | "note">;

describe("exportSenderDecisionsToCsv", () => {
  it("emits header + rows in the documented order", () => {
    const csv = exportSenderDecisionsToCsv([
      {
        senderEmail: "a@example.com",
        senderDomain: "example.com",
        action: "auto_trash",
        source: "user",
        note: "ads",
        messageCount: 42,
        firstSeenAt: new Date("2025-01-01T00:00:00Z"),
        lastSeenAt: new Date("2025-02-01T00:00:00Z"),
        updatedAt: new Date("2025-02-10T00:00:00Z"),
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "senderEmail,senderDomain,action,source,note,messageCount,firstSeenAt,lastSeenAt,updatedAt",
    );
    expect(lines[1]).toBe(
      "a@example.com,example.com,auto_trash,user,ads,42,2025-01-01T00:00:00.000Z,2025-02-01T00:00:00.000Z,2025-02-10T00:00:00.000Z",
    );
  });

  it("quotes notes containing commas", () => {
    const csv = exportSenderDecisionsToCsv([
      {
        senderEmail: "a@example.com",
        senderDomain: "example.com",
        action: "review",
        source: "user",
        note: "hello, world",
        messageCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        updatedAt: new Date("2025-02-10T00:00:00Z"),
      },
    ]);
    expect(csv).toContain('"hello, world"');
  });
});

describe("parseSenderDecisionCsv", () => {
  it("parses the minimal two-column CSV", () => {
    const { rows, errors } = parseSenderDecisionCsv(
      "senderEmail,action\na@example.com,auto_trash\nb@example.com,review\n",
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      senderEmailCanonical: "a@example.com",
      action: "auto_trash",
    });
  });

  it("canonicalizes addresses (display name + plus tag)", () => {
    // Raw CSV line: """Name"" <A+tag@Example.COM>",review
    const csv = 'senderEmail,action\n"""Name"" <A+tag@Example.COM>",review\n';
    const { rows, errors } = parseSenderDecisionCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0].senderEmailCanonical).toBe("a@example.com");
  });

  it("captures row-level errors for bad action + bad email without aborting", () => {
    const { rows, errors } = parseSenderDecisionCsv(
      [
        "senderEmail,action",
        "good@example.com,auto_trash",
        "bad@example.com,teleport_to_mars",
        "not-an-email,review",
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].senderEmailCanonical).toBe("good@example.com");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ row: 2, field: "action" });
    expect(errors[1]).toMatchObject({ row: 3, field: "senderEmail" });
  });

  it("complains when required header columns are missing", () => {
    const { errors } = parseSenderDecisionCsv(
      "email,decision\na@b.com,review\n",
    );
    expect(errors[0].message).toMatch(/Missing required header/);
  });
});

describe("computeImportDiff", () => {
  const parse = (csv: string) => parseSenderDecisionCsv(csv);

  it("creates rows that don't exist yet", () => {
    const parsed = parse("senderEmail,action\nnew@example.com,auto_trash\n");
    const diff = computeImportDiff(parsed, new Map());
    expect(diff.creates).toHaveLength(1);
    expect(diff.creates[0]).toMatchObject({
      senderEmail: "new@example.com",
      action: "auto_trash",
    });
    expect(diff.updates).toHaveLength(0);
    expect(diff.skipped).toHaveLength(0);
  });

  it("updates when action or note differs", () => {
    const parsed = parse(
      "senderEmail,action,note\nchange@example.com,auto_trash,newnote\n",
    );
    const existing = new Map<string, ExistingRow>([
      [
        "change@example.com",
        { action: "review", source: "user", note: "oldnote" },
      ],
    ]);
    const diff = computeImportDiff(parsed, existing);
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0].before.action).toBe("review");
    expect(diff.updates[0].after.action).toBe("auto_trash");
    expect(diff.updates[0].after.note).toBe("newnote");
    expect(diff.updates[0].after.source).toBe("user");
  });

  it("flips seed rows to user source on change", () => {
    const parsed = parse("senderEmail,action\nseeded@example.com,auto_trash\n");
    const existing = new Map<string, ExistingRow>([
      [
        "seeded@example.com",
        { action: "auto_trash", source: "seed", note: null },
      ],
    ]);
    const diff = computeImportDiff(parsed, existing);
    // Action is unchanged but source transition forces an update entry.
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0].before.source).toBe("seed");
    expect(diff.updates[0].after.source).toBe("user");
  });

  it("skips rows with no change", () => {
    const parsed = parse(
      "senderEmail,action,note\nsame@example.com,review,ok\n",
    );
    const existing = new Map<string, ExistingRow>([
      ["same@example.com", { action: "review", source: "user", note: "ok" }],
    ]);
    const diff = computeImportDiff(parsed, existing);
    expect(diff.skipped).toHaveLength(1);
    expect(diff.skipped[0].reason).toBe("No change");
    expect(diff.updates).toHaveLength(0);
    expect(diff.creates).toHaveLength(0);
  });

  it("de-dupes within the CSV and records a skipped note", () => {
    const parsed = parse(
      "senderEmail,action\ndup@example.com,review\ndup@example.com,auto_trash\n",
    );
    const diff = computeImportDiff(parsed, new Map());
    expect(diff.creates).toHaveLength(1);
    expect(diff.creates[0].action).toBe("auto_trash"); // last wins
    expect(diff.skipped).toHaveLength(1);
    expect(diff.skipped[0].reason).toMatch(/Duplicate in CSV/);
  });
});
