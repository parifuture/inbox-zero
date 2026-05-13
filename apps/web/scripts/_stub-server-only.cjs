// EL-426 helper: stub `server-only` so scripts can run outside the RSC runtime.
// Used by scripts/recategorize-stalled.ts via NODE_OPTIONS=--require ./scripts/_stub-server-only.cjs.
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    children: [],
    paths: [],
    exports: {},
  };
} catch {
  // nothing to stub
}
