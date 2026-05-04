# Parity classifier (EL-358)

Fork-side port of the sidecar's 4-stage classifier. Lives here so the fork can
eventually make autonomous triage decisions without depending on the sidecar.

## Status: EL-358a shipped (port mechanics)

Pure, pure, pure. Everything in this directory is a deterministic function of
its inputs — no DB reads, no Gmail calls, no network, no Bedrock. That makes it
trivial to unit-test and safe to import from anywhere.

What ships in EL-358a:

| File         | Source                          | Notes                                   |
| ------------ | ------------------------------- | --------------------------------------- |
| `types.ts`   | sidecar `types.ts`              | Trimmed to the classifier's needs only. |
| `stages.ts`  | sidecar `pipeline.ts` (extract) | `checkStage0Protected`, `checkStage1BulkMail`. `ea.com` is now a parameter, not a constant. |
| `domains.ts` | sidecar `domains.ts`            | Verbatim domain table (same order, same categories, same rule names). |
| `scorer.ts`  | sidecar `scorer.ts`             | Verbatim. Thresholds exported. |
| `policy.ts`  | sidecar `policy.ts`             | Verbatim. `VALID_LABELS` exported. |
| `ParityDecision` (Prisma) | new | Shadow-mode decision table. **Not written to yet.** |

The `ParityDecision` migration lands in this PR so EL-358b can focus on runner
wiring + observability without touching schema. The model is included in the
schema file with the fields EL-358b will need; no code writes to it yet.

## Next: EL-358b (shadow wiring) — SHIPPED

The runner is wired. Entry point: `scheduleParityShadow({ emailAccount, message })`
is called from `utils/webhook/process-history-item.ts` immediately before
`runRules`. It no-ops when `PARITY_SHADOW_ENABLED` is false.

Implementation split:

- `sender-aggregate.ts` — `buildSenderAggregate(emailAccountId, senderEmail)`
  re-derives `SenderAggregate` from `EmailMessage` + `ResponseTime`. No
  new ingestion path; we read what the reply-tracker already writes.
- `bedrock.ts` — `classifyEmailForParity` wraps Stage 4 via the fork's
  `createGenerateObject` (NOT a direct `@aws-sdk/client-bedrock-runtime`
  import). Retries, fallback models, and usage metering all inherited.
- `runner.ts` — `runParityPipeline` orchestrates stages 0-4;
  `persistParityDecision` is the only writer; `scheduleParityShadow` is
  the call-site-friendly wrapper that defers to `after()`.

Feature flags (added to `env.ts`):

- `PARITY_SHADOW_ENABLED` — master switch. Default off.
- `PARITY_SHADOW_BEDROCK_ENABLED` — gates Stage 4 specifically. Default
  off so stages 0-3 can be observed for free before turning on Bedrock
  spend.
- `PARITY_PRIMARY_DOMAIN` — replaces the sidecar's hardcoded `ea.com`
  in the Stage 0 protected-class check. Leave unset for no primary
  domain override.

Kill-switch integration: the runner calls `isAutonomousPaused` before
Stage 4. When paused we still run stages 0-3 (cheap) but skip Bedrock
and emit `reasoning='Stage 4 skipped (skipped_by_kill_switch)'`.

Next handoff — EL-363 (parity verification):

- [ ] Add a Decisions-tab pane that joins `ParityDecision` to
      `SenderDecision`/`ExecutedRule` and surfaces agreement rate vs
      sidecar.
- [ ] Populate `sidecarAction` / `sidecarRuleName` on `ParityDecision`
      rows by replaying sidecar `spam_decisions` entries.
- [ ] Set a target agreement threshold; block sidecar sunset until
      met.

## Previous: EL-358b (shadow wiring) — original handoff checklist

- [ ] Wire `runParityPipeline` into the new-mail webhook path with a feature
      flag (`PARITY_SHADOW_ENABLED`, defaulted off).
- [ ] Plumb `emailAccountPrimaryDomain` from `EmailAccount` (don't hardcode
      `ea.com`).
- [ ] Use `buildSenderAggregate(emailAccountId, senderEmail)` — helper to
      compute a `SenderAggregate` from `EmailMessage` + `Rule` replies.
- [ ] Reuse the kill-switch pre-check from EL-370. If the account is paused
      AND the parity runner would have mutated anything (it won't in shadow),
      skip and record `skipped_by_kill_switch`. Still safe to write a
      `ParityDecision` row — that's inert observability.
- [ ] Emit structured logs: `{event:"parity.decision", stage, action, ...}`.
- [ ] Add a Decisions-tab pane that shows agreement rate vs sidecar once
      we have enough rows. (Or defer to EL-363.)

## Why this port is split into two PRs

EL-358 is the biggest remaining ticket in the zero-inbox queue. Shipping the
port as a pure-functions PR first means:

- Every stage primitive can be tested against the sidecar's existing test
  vectors before any live traffic touches it.
- The schema change lands in isolation — easy to back out, no runtime coupling.
- EL-358b becomes a runner-only PR, so reviewers can focus on wiring,
  observability, and kill-switch integration instead of relitigating the
  classifier logic.

## Why `ParityDecision` is a separate table from `SenderDecision`

- `SenderDecision` is a **user-facing truth table** — what Chotu wants to
  happen to future mail from a sender. Writes from the parity runner would
  silently pollute it.
- `ParityDecision` is a **per-message observability log** — what the new
  classifier thought on this exact message, independent of any user decision.
- They join on `(emailAccountId, senderEmail)` but never overwrite each other.

## Safety

This code **cannot** trigger a Gmail mutation today. The only thing it can do
is return a JS object. Shadow wiring (EL-358b) preserves that guarantee: it
writes to `ParityDecision` and nothing else.
