/**
 * Compile-time exhaustiveness guard. Placing `assertNever(x)` in the default
 * branch of a switch over a discriminated union makes the build fail if a new
 * variant is added without handling it — the cornerstone of the strategy and
 * pod-status models staying in sync as they grow.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

/** Narrow an unknown caught error to a message without leaking `any`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
