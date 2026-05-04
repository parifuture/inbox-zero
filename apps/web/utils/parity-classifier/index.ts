/**
 * EL-358a — parity classifier (public surface).
 *
 * This is a **port of the sidecar's 4-stage classifier as pure modules**.
 * It does not run in shadow mode yet, and it does NOT write to
 * `ParityDecision`. That wiring ships in EL-358b.
 *
 * What you get today:
 *   - `checkStage0Protected`, `checkStage1BulkMail`    (stages.ts)
 *   - `lookupDomainCategory`, `DOMAIN_RULES`            (domains.ts)
 *   - `computeScore`, INBOX_THRESHOLD, REVIEW_THRESHOLD (scorer.ts)
 *   - `applyPolicy`, `VALID_LABELS`                     (policy.ts)
 *
 * Import from the specific submodule — we intentionally avoid a barrel
 * re-export so tree-shaking stays tight and the build graph stays small.
 * See `README.md` for the full handoff to EL-358b.
 */

export {}; // marker: intentionally empty; submodules are the public surface.
