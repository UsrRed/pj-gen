import { describe, expect, it, vi } from 'vitest';
import { SessionPool, releaseAll } from '../src/core/sessionPool.js';

describe('SessionPool', () => {
  it('never issues more leases than the limit', () => {
    const pool = new SessionPool(() => 3);
    expect(pool.available).toBe(3);

    const first = pool.tryAcquire(2);
    expect(first.length).toBe(2);
    expect(pool.available).toBe(1);

    // Asking for more than what is free returns only what is free — it never blocks.
    const second = pool.tryAcquire(5);
    expect(second.length).toBe(1);
    expect(pool.available).toBe(0);
    expect(pool.tryAcquire(1)).toEqual([]);

    releaseAll([...first, ...second]);
    expect(pool.available).toBe(3);
    expect(pool.inUse).toBe(0);
  });

  it('ignores a double release so a lease cannot free someone else’s slot', () => {
    const pool = new SessionPool(() => 2);
    const [lease] = pool.tryAcquire(1);
    lease.release();
    lease.release();
    expect(pool.inUse).toBe(0);
    expect(pool.available).toBe(2);
  });

  it('pokes the scheduler on release so a waiting project starts promptly', () => {
    const onRelease = vi.fn();
    const pool = new SessionPool(() => 1, onRelease);
    const lease = pool.acquireOne()!;
    expect(onRelease).not.toHaveBeenCalled();
    lease.release();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('follows a live limit change without a restart', () => {
    let limit = 1;
    const pool = new SessionPool(() => limit);
    const held = pool.tryAcquire(1);
    expect(pool.available).toBe(0);

    limit = 4;
    expect(pool.available).toBe(3);

    // Lowering below what is held clamps to zero rather than going negative.
    limit = 1;
    expect(pool.available).toBe(0);
    releaseAll(held);
  });

  it('treats a limit of 0 as 1 so the scheduler can never fully stall', () => {
    const pool = new SessionPool(() => 0);
    expect(pool.limit).toBe(1);
    expect(pool.acquireOne()).not.toBeNull();
  });
});
