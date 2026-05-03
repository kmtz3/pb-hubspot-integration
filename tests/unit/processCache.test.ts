import { memoizeWithTtl } from '../../src/lib/processCache';

describe('memoizeWithTtl', () => {
  it('caches the resolved value within the TTL window', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      return calls;
    });
    const memo = memoizeWithTtl(fn, 1000);

    const a = await memo();
    const b = await memo();

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has elapsed', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const memo = memoizeWithTtl(async () => ++calls, 1000);

      jest.setSystemTime(0);
      expect(await memo()).toBe(1);

      jest.setSystemTime(500);
      expect(await memo()).toBe(1); // still cached

      jest.setSystemTime(1500);
      expect(await memo()).toBe(2); // TTL elapsed; refetch
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares an in-flight promise across concurrent callers', async () => {
    let calls = 0;
    let resolveInner: (v: number) => void = () => {};
    const innerPromise = new Promise<number>(resolve => { resolveInner = resolve; });
    const fn = jest.fn(async () => {
      calls++;
      return innerPromise;
    });
    const memo = memoizeWithTtl(fn, 60_000);

    const p1 = memo();
    const p2 = memo();
    const p3 = memo();

    resolveInner(42);

    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
    expect(await p3).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1); // only one underlying call despite three callers
  });

  it('drops a poisoned entry on rejection so the next caller retries', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('first fails');
      return calls;
    });
    const memo = memoizeWithTtl(fn, 60_000);

    await expect(memo()).rejects.toThrow('first fails');
    // Without the poison-drop, this would inherit the rejected promise from
    // the first call. We expect a fresh fetch instead.
    expect(await memo()).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
