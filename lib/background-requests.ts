// IDs are scoped to the sending document so cancelling one tab cannot stop another.
export class BackgroundRequests {
  private active = new Map<string, AbortController>();
  private cancelled = new Map<string, number>();

  private key(scope: string, id: string) {
    if (!id || id.length > 128) throw new Error('资源请求 ID 无效');
    const now = Date.now();
    for (const [key, time] of this.cancelled) {
      if (now - time > 60_000) this.cancelled.delete(key);
    }
    return JSON.stringify([scope, id]);
  }

  cancel(scope: string, id: string) {
    const key = this.key(scope, id);
    const controller = this.active.get(key);
    if (controller) controller.abort(new DOMException('已取消下载', 'AbortError'));
    else {
      // The abort message can arrive before the original request is dispatched.
      if (this.cancelled.size >= 512) this.cancelled.delete(this.cancelled.keys().next().value!);
      this.cancelled.set(key, Date.now());
    }
  }

  async run<T>(scope: string, id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = this.key(scope, id);
    if (this.cancelled.delete(key)) throw new DOMException('已取消下载', 'AbortError');
    if (this.active.has(key)) throw new Error('资源请求 ID 重复');
    const controller = new AbortController();
    this.active.set(key, controller);
    try { return await work(controller.signal); }
    finally { this.active.delete(key); }
  }
}
