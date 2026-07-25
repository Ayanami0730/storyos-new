import assert from "node:assert/strict";

/**
 * Run `fn`, assert it threw the expected error type, and return the error so
 * its fields can be asserted. `assert.throws` returns void, so it cannot be
 * used when the test needs to inspect the error object.
 */
export function captureError<T extends Error>(
  fn: () => unknown,
  type: new (...args: never[]) => T,
): T {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${type.name} to be thrown` });
}
