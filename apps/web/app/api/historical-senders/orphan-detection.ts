// EL-323 orphan-scan recovery helper. Extracted into its own file so it can
// be unit-tested without pulling in Next server-only modules (route.ts is a
// server module and cannot be imported from a test that runs in the plain
// vitest environment).

export const ORPHAN_SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

export function isOrphanedScan(
  scan: { status: string; updatedAt: Date | null; startedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (scan.status !== "running") return false;
  const heartbeat = scan.updatedAt ?? scan.startedAt ?? now;
  return now.getTime() - heartbeat.getTime() > ORPHAN_SCAN_TIMEOUT_MS;
}
