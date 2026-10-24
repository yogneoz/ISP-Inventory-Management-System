/**
 * Runs an async worker over a list with a bounded number in flight, keeping
 * the results in input order.
 *
 * The reports batch endpoint computes one financial summary per branch ×
 * fiscal year, and each summary is a small set of aggregate queries. Running
 * the pairs one after another made a wide request needlessly slow; running all
 * of them at once would put `pairs × 9` queries on a pool that defaults to 20
 * connections. This keeps the request parallel but bounded, so the pool is not
 * monopolised by one client.
 *
 * Rejections propagate: the first failing worker rejects the returned promise,
 * which the route forwarder turns into the endpoint's error response. Workers
 * already started are not cancelled (they are short aggregate reads).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}
