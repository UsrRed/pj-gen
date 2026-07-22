/** Per-key promise-chain mutex: serializes all mutations of one project. */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined)
    );
    try {
      return await next;
    } finally {
      if (this.chains.get(key) !== undefined) {
        // Drop the chain entry once settled and no queued successor replaced it.
        const cur = this.chains.get(key);
        cur?.then(() => {
          if (this.chains.get(key) === cur) this.chains.delete(key);
        });
      }
    }
  }
}
