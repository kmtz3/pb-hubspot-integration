import {
  parseHubSpotHeaders,
  parsePBHeaders,
  shouldBackOffHubSpot,
  shouldBackOffPB,
  getRetryAfterMs,
  withRetry,
} from '../../src/sync/rateLimit';

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('parseHubSpotHeaders', () => {
  it('parses all three rate limit headers', () => {
    const h = makeHeaders({
      'x-hubspot-ratelimit-remaining': '45',
      'x-hubspot-ratelimit-max': '100',
      'x-hubspot-ratelimit-interval-milliseconds': '10000',
    });
    expect(parseHubSpotHeaders(h)).toEqual({ remaining: 45, max: 100, intervalMs: 10000 });
  });

  it('returns nulls for absent headers', () => {
    expect(parseHubSpotHeaders(new Headers())).toEqual({ remaining: null, max: null, intervalMs: null });
  });
});

describe('parsePBHeaders', () => {
  it('parses remaining header', () => {
    expect(parsePBHeaders(makeHeaders({ 'x-ratelimit-remaining': '25' }))).toEqual({ remaining: 25 });
  });

  it('returns null for absent header', () => {
    expect(parsePBHeaders(new Headers())).toEqual({ remaining: null });
  });
});

describe('shouldBackOffHubSpot', () => {
  it('returns true when remaining/max < 0.2', () => {
    expect(shouldBackOffHubSpot({ remaining: 15, max: 100, intervalMs: 10000 })).toBe(true);
  });

  it('returns false when remaining/max >= 0.2', () => {
    expect(shouldBackOffHubSpot({ remaining: 25, max: 100, intervalMs: 10000 })).toBe(false);
  });

  it('returns false when values are null', () => {
    expect(shouldBackOffHubSpot({ remaining: null, max: null, intervalMs: null })).toBe(false);
  });
});

describe('shouldBackOffPB', () => {
  it('returns true when remaining < 10', () => {
    expect(shouldBackOffPB({ remaining: 5 })).toBe(true);
  });

  it('returns false when remaining >= 10', () => {
    expect(shouldBackOffPB({ remaining: 10 })).toBe(false);
  });

  it('returns false for null', () => {
    expect(shouldBackOffPB({ remaining: null })).toBe(false);
  });
});

describe('getRetryAfterMs', () => {
  it('parses retry-after header in seconds', () => {
    expect(getRetryAfterMs(makeHeaders({ 'retry-after': '5' }))).toBe(5000);
  });

  it('returns 1000 when header is absent', () => {
    expect(getRetryAfterMs(new Headers())).toBe(1000);
  });
});

describe('withRetry — timing (fake timers)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function drainWithTimers(promise: Promise<unknown>): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    }
    await promise.catch(() => {});
  }

  it('returns data on first success', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 200, headers: new Headers(), data: { ok: true } });
    await expect(withRetry(fn)).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times on 5xx then throws', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 503, headers: new Headers(), data: null });
    const promise = withRetry(fn);
    await drainWithTimers(promise);
    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('throws immediately on 4xx (not 429)', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 404, headers: new Headers(), data: null });
    await expect(withRetry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('formats Productboard validation envelopes as user-facing messages with reportable IDs', async () => {
    const fn = jest.fn().mockResolvedValue({
      status: 400,
      headers: new Headers(),
      data: {
        errors: [{
          code: 'validation.failed',
          title: 'Validation failed',
          detail: 'Number decimal scale cannot be larger than 2, was 2.56113',
          source: { pointer: '/data/fields/040816be-6505-50ed-a614-baeef94a0929' },
        }],
        id: '55f110e4-87fe-4ee1-bb38-389a4d772101',
      },
    });

    await expect(withRetry(fn)).rejects.toThrow(
      'Request was rejected by the API (HTTP 400) — Number decimal scale cannot be larger than 2, was 2.56113 (field/entity: 040816be-6505-50ed-a614-baeef94a0929; code: validation.failed; error id: 55f110e4-87fe-4ee1-bb38-389a4d772101)'
    );
  });

  it('formats HubSpot-style message envelopes without raw JSON', async () => {
    const fn = jest.fn().mockResolvedValue({
      status: 403,
      headers: new Headers(),
      data: {
        message: 'This app has not been granted all required scopes.',
        category: 'MISSING_SCOPES',
        correlationId: 'abc-123',
      },
    });

    await expect(withRetry(fn)).rejects.toThrow(
      'Request was rejected by the API (HTTP 403) — This app has not been granted all required scopes. (category: MISSING_SCOPES; correlation id: abc-123)'
    );
  });

  it('retries after retry-after delay on 429', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce({ status: 429, headers: makeHeaders({ 'retry-after': '1' }), data: null })
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: 'ok' });
    const promise = withRetry(fn);
    await drainWithTimers(promise);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('succeeds on second attempt after first 5xx', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce({ status: 503, headers: new Headers(), data: null })
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: 'recovered' });
    const promise = withRetry(fn);
    await drainWithTimers(promise);
    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
