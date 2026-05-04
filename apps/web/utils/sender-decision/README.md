# `sender-decision`

Authoritative per-sender triage decisions for the forked Inbox Zero.

One row per `(emailAccountId, canonicalizedSenderEmail)` in the Postgres
`SenderDecision` table. This is the single source of truth consulted by both:

1. The incoming-mail Rules engine (picks up `auto_trash` / `auto_archive` /
   `always_keep` before invoking the LLM — see EL-356).
2. The backlog applier (one-shot pass over the historical mailbox — EL-357).

Sidecar's legacy `sender_truth` table stays running until parity is proven.
This module is the in-fork replacement.

## Schema

See `apps/web/prisma/schema.prisma` — model `SenderDecision`, enum
`SenderAction` (`auto_trash` | `auto_archive` | `always_keep` | `review`).

## Helpers

```ts
import {
  canonicalizeSender,
  getDecision,
  upsertDecision,
  listByAction,
} from "@/utils/sender-decision";
```

- `canonicalizeSender(raw)` — turns `"Jane" <J+tag@Domain.COM>` into
  `j@domain.com`. Lowercases, strips display name, strips `+tag`. Returns
  `""` on invalid input.
- `getDecision(emailAccountId, rawOrCanonicalEmail)` — returns the typed row
  or `null`.
- `upsertDecision({...})` — idempotent. By default, a non-`"user"` source
  will NOT overwrite an existing row whose `source === "user"`; only the
  volume telemetry (`firstSeenAt` / `lastSeenAt` / `messageCount`) is
  refreshed. Pass `protectUserDecisions: false` to force-overwrite.
- `listByAction(action, { emailAccountId, take, skip, domain, search })` —
  sorted by `messageCount desc, lastSeenAt desc`.

## Seeding from sidecar

One-time / periodic backfill from the legacy sidecar Postgres:

```bash
SIDECAR_DATABASE_URL="postgres://sidecar:pw@localhost:5433/sidecar" \
pnpm --filter inbox-zero-ai exec tsx scripts/seed-sender-decision.ts \
  --email pari.future@gmail.com
```

Mapping (sidecar → fork):

| Sidecar `category` / `action` | Fork `SenderAction` |
|---|---|
| `action = "trash"` or `category ∈ {BULK, marketing, promotional}` | `auto_trash` |
| `category ∈ {TRANSACTIONAL, receipts, sent-history}` or `action ∈ {archive, inbox, keep}` | `always_keep` |
| anything else | `review` |

Volume stats (`firstSeenAt` / `lastSeenAt` / `messageCount`) are computed
from the local `EmailMessage` table, so results get better as Inbox Zero
syncs more history.

## Follow-ups (not wired yet)

- EL-355 — Admin Decisions tab + SenderDetail drill-in.
- EL-356 — Rules engine consults `getDecision(...)` before the LLM.
- EL-357 — Backlog applier processes `auto_trash` / `auto_archive` rows.
