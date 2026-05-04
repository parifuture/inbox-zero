import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("braintrust");

/**
 * Braintrust no-op shim for self-hosted fork.
 *
 * The original used `braintrust` for LLM eval dataset writes. The
 * self-hosted single-user fork doesn't ship evals, so this class preserves
 * the public surface (`insertToDataset`) but does nothing.
 *
 * See EL-359 — telemetry strip.
 */
export class Braintrust {
  constructor(_dataset: string) {
    // no-op — we never talk to braintrust from the fork.
    if (process.env.BRAINTRUST_API_KEY) {
      logger.info(
        "BRAINTRUST_API_KEY is set but braintrust is disabled in the self-hosted fork",
      );
    }
  }

  insertToDataset(_data: { id: string; input: unknown; expected?: unknown }) {
    /* no-op */
  }
}
