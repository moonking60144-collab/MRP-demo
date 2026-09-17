interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

export class ClientScopedAsyncCache<T> {
  private stores = new WeakMap<object, Map<string, CacheEntry<T>>>();

  constructor(
    private maxEntries = 18,
    private ttlMs = 5 * 60_000,
  ) {}

  get(
    client: object,
    key: string,
    load: () => Promise<T>,
    now = Date.now(),
  ): Promise<T> {
    let store = this.stores.get(client);
    if (!store) {
      store = new Map();
      this.stores.set(client, store);
    }

    const cached = store.get(key);
    if (cached && cached.expiresAt > now) {
      store.delete(key);
      store.set(key, cached);
      return cached.value;
    }
    if (cached) store.delete(key);

    const value = load();
    const entry = { value, expiresAt: now + this.ttlMs };
    store.set(key, entry);
    while (store.size > this.maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    void value.catch(() => {
      if (store!.get(key) === entry) store!.delete(key);
    });
    return value;
  }
}
