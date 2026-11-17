/**
 * Submit → poll → timeout, shared by reports, bulk downloads and bulk uploads.
 *
 * Each of those jobs runs server-side for an unknown time. The loop polls
 * until the job leaves its pending state or the budget runs out; on timeout
 * the caller turns the last pending status into a resumable result rather
 * than an error, because the job is still running and can be collected later.
 *
 * Time comes from an injectable `Clock` so the budget-expiry path can be
 * tested without waiting.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface PollJobOptions<T, R> {
  /**
   * One status check. `elapsedMs()` reads the time since polling started, for
   * results that report how long they waited.
   */
  poll(attempt: number, elapsedMs: () => number): Promise<T>;
  isPending(result: T): boolean;
  /** Stop polling once this much time has passed with the job still pending. */
  budgetMs: number;
  /** Wait before the next poll, given the attempt that just ran. */
  delay(attempt: number): number;
  /** Build the result for a job still pending when the budget ran out. */
  onTimeout(last: T, elapsedMs: number): R;
  clock?: Clock;
}

export async function pollJob<T, R>(opts: PollJobOptions<T, R>): Promise<T | R> {
  const clock = opts.clock ?? systemClock;
  const started = clock.now();
  const elapsedMs = () => clock.now() - started;

  for (let attempt = 0; ; attempt++) {
    const result = await opts.poll(attempt, elapsedMs);
    if (!opts.isPending(result)) return result;

    const elapsed = elapsedMs();
    if (elapsed >= opts.budgetMs) return opts.onTimeout(result, elapsed);

    await clock.sleep(opts.delay(attempt));
  }
}
