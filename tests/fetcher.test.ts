import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClassifier,
  createTaxonomyPlanner,
  type ClassificationRequest,
  type ProviderEndpoint,
  type TaxonomyRequest,
} from '../src/background/classifier';
import { detachFetch } from '../src/shared/fetcher';
import { PROVIDERS } from '../src/shared/provider';

const ILLEGAL_INVOCATION = "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation";

/**
 * Stands in for native `fetch`, which is an operation on the global object: handing it some other
 * receiver is what the service worker rejects as an illegal invocation. The plain stubs used by
 * the other suites accept every receiver, so only this one can catch the mistake.
 */
interface ReceiverWatch {
  /** The illegal invocation the adapters would otherwise bury under their own error. */
  rejectedReceiver: boolean;
  calls: number;
}

function installReceiverCheckingFetch(): ReceiverWatch {
  const watch: ReceiverWatch = { rejectedReceiver: false, calls: 0 };
  const strictFetch = function (this: unknown): Promise<Response> {
    watch.calls += 1;
    if (this !== undefined && this !== globalThis) {
      watch.rejectedReceiver = true;
      return Promise.reject(new TypeError(ILLEGAL_INVOCATION));
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  };
  vi.stubGlobal('fetch', strictFetch as unknown as typeof fetch);
  return watch;
}

/** Adapters translate every transport failure into their own error, so swallow it here. */
async function ignoringFailure(call: Promise<unknown>): Promise<void> {
  await call.catch(() => undefined);
}

const endpoint: ProviderEndpoint = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://provider.example.test/v1',
};

const classificationRequest: ClassificationRequest = {
  mode: 'synchronization',
  locale: 'en',
  tabs: [
    { ref: 'tab-1', title: 'Apollo billing', hostname: 'billing.example.test', currentGroup: null },
  ],
  groups: [],
  presets: [],
};

const taxonomyRequest: TaxonomyRequest = {
  locale: 'en',
  tabs: [{ ref: 'tab-1', title: 'Apollo billing', hostname: 'billing.example.test' }],
  groups: [],
  presets: [],
  maxTitles: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detachFetch', () => {
  it('reaches native fetch whichever receiver the caller happens to hold it on', async () => {
    installReceiverCheckingFetch();
    const holder = { send: detachFetch(fetch) };

    await expect(holder.send('https://provider.example.test/v1/models')).resolves.toBeDefined();
  });
});

describe('classifier adapters', () => {
  it.each(PROVIDERS)('classifies through %s without offering itself as the fetch receiver', async (provider) => {
    const watch = installReceiverCheckingFetch();

    await ignoringFailure(createClassifier(provider, endpoint).classify(classificationRequest));

    expect(watch.calls).toBeGreaterThan(0);
    expect(watch.rejectedReceiver).toBe(false);
  });

  it.each(PROVIDERS)('plans %s taxonomy without offering itself as the fetch receiver', async (provider) => {
    const watch = installReceiverCheckingFetch();

    await ignoringFailure(createTaxonomyPlanner(provider, endpoint).plan(taxonomyRequest));

    expect(watch.calls).toBeGreaterThan(0);
    expect(watch.rejectedReceiver).toBe(false);
  });
});
