/** Retries a startup check until it passes. Containers come up in any order. */
export async function retryUntilReady(name: string, check: () => Promise<unknown>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${name} not ready after ${timeoutMs}ms: ${String(error)}`, { cause: error });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
