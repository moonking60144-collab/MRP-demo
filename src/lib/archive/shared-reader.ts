interface SharedResourceEntry<T> {
  key: string;
  resource: T;
  users: number;
  retired: boolean;
  validation?: Promise<void>;
  disposal?: Promise<void>;
}

export class ValidatedSharedResource<T> {
  private current?: SharedResourceEntry<T>;

  constructor(
    private create: (key: string) => T,
    private validate: (resource: T) => Promise<void>,
    private dispose: (resource: T) => Promise<void>,
  ) {}

  private retire(entry: SharedResourceEntry<T>) {
    if (entry.retired) return;
    entry.retired = true;
    if (this.current === entry) this.current = undefined;
    this.disposeWhenIdle(entry);
  }

  private disposeWhenIdle(entry: SharedResourceEntry<T>) {
    if (!entry.retired || entry.users > 0 || entry.disposal) return;
    entry.disposal = this.dispose(entry.resource).catch(() => undefined);
  }

  async use<R>(key: string, callback: (resource: T) => Promise<R>): Promise<R> {
    let entry = this.current;
    if (!entry || entry.key !== key || entry.retired) {
      if (entry) this.retire(entry);
      entry = { key, resource: this.create(key), users: 0, retired: false };
      this.current = entry;
    }

    entry.users += 1;
    let validationPassed = false;
    try {
      const validation = entry.validation ?? this.validate(entry.resource);
      entry.validation = validation;
      try {
        await validation;
      } finally {
        if (entry.validation === validation) entry.validation = undefined;
      }
      validationPassed = true;
      return await callback(entry.resource);
    } catch (error) {
      if (!validationPassed) this.retire(entry);
      throw error;
    } finally {
      entry.users -= 1;
      this.disposeWhenIdle(entry);
    }
  }
}
