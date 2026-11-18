/**
 * Runs long work while renewing a claim on it, such as a lease on a row that says another
 * job is already working on it. The claim is kept short, so if the process dies, it runs
 * out soon and another job can take over, and renewed for as long as the work runs. A
 * failed renewal is reported, and the work carries on: the claim only keeps others away.
 */
export async function withRenewal<T>(
  renew: () => Promise<void>,
  options: { readonly everyMs: number; readonly onError?: (error: unknown) => void },
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    renew().catch((error: unknown) => options.onError?.(error));
  }, options.everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
