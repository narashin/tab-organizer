/**
 * Detaches a fetch reference from whatever object ends up holding it.
 *
 * Native `fetch` is an operation on the global object, so it only accepts the global — or no
 * receiver at all — as `this`. Parking the bare reference in a field and calling it back through
 * that field hands the owning object over as the receiver, and the service worker rejects it with
 * "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation". The extension only hit
 * this in production: injected test doubles are ordinary functions that accept every receiver.
 *
 * The wrapper turns the real call back into a plain identifier call, so a holder can invoke it
 * however reads best without carrying that rule around.
 */
export function detachFetch(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, init);
}
