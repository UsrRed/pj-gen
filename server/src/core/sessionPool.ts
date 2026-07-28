/**
 * Global ceiling on concurrent BUILD `claude -p` processes.
 *
 * `maxConcurrentBuilds` counts projects, not sessions. Once a single project can run
 * several implementation tasks at once, that stops being the real resource bound — this
 * pool is. It also caps concurrent verifications for free, since `npm test` runs inside
 * a session's validate().
 *
 * Deliberately NON-BLOCKING: `tryAcquire` never waits. The scheduler takes one lease per
 * admitted project and holds it for the whole build; parallel task batches borrow extra
 * leases opportunistically and simply run narrower when none are free. Nothing can ever
 * wait on a lease held by something that is itself waiting.
 *
 * Interactive sessions (cadrage, spec, deploy, micro, ci, import) never touch the pool:
 * framing a project must stay responsive while builds saturate it.
 */
export interface Lease {
  release(): void;
}

export class SessionPool {
  private held = 0;

  constructor(
    private limitFn: () => number,
    private onRelease: () => void = () => {}
  ) {}

  get limit(): number {
    return Math.max(1, this.limitFn());
  }

  get inUse(): number {
    return this.held;
  }

  get available(): number {
    return Math.max(0, this.limit - this.held);
  }

  /** Takes up to `n` leases, returning however many were free (possibly none). */
  tryAcquire(n: number): Lease[] {
    const granted = Math.max(0, Math.min(n, this.available));
    const leases: Lease[] = [];
    for (let i = 0; i < granted; i++) leases.push(this.makeLease());
    return leases;
  }

  /** Convenience for the scheduler's one-per-project base lease. */
  acquireOne(): Lease | null {
    return this.tryAcquire(1)[0] ?? null;
  }

  private makeLease(): Lease {
    this.held += 1;
    let released = false;
    return {
      release: () => {
        if (released) return; // double-release must not free someone else's slot
        released = true;
        this.held -= 1;
        this.onRelease();
      },
    };
  }
}

/** Releases every lease in a batch, ignoring double-releases. */
export function releaseAll(leases: Lease[]): void {
  for (const l of leases) l.release();
}
