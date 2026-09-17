export interface RunDetailRequestToken {
  runId: number;
  generation: number;
}

export class RunDetailRequestTracker<T> {
  private readonly generations = new Map<number, number>();
  private readonly inFlight = new Map<number, {
    token: RunDetailRequestToken;
    request: Promise<T>;
  }>();

  get(runId: number): Promise<T> | undefined {
    return this.inFlight.get(runId)?.request;
  }

  capture(runId: number): RunDetailRequestToken {
    return {
      runId,
      generation: this.generations.get(runId) ?? 0,
    };
  }

  track(token: RunDetailRequestToken, request: Promise<T>): void {
    this.inFlight.set(token.runId, { token, request });
  }

  invalidate(runId: number): void {
    this.generations.set(runId, (this.generations.get(runId) ?? 0) + 1);
    this.inFlight.delete(runId);
  }

  isCurrent(token: RunDetailRequestToken): boolean {
    return (
      (this.generations.get(token.runId) ?? 0) === token.generation
      && this.inFlight.get(token.runId)?.token === token
    );
  }

  finish(token: RunDetailRequestToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.inFlight.delete(token.runId);
    return true;
  }
}
