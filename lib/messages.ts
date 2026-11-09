type ResourceRequest = (
  | { kind: 'pdf-url'; bookId: string }
  | { kind: 'pdf-save'; url: string; name: string; bookId: string }
  | { kind: 'asset'; url: string; retry?: boolean }
) & { requestId?: string };

export type Request = ResourceRequest
  | { kind: 'history-check' | 'history-record'; bookId: string }
  | { kind: 'history-check-reader'; readerId: string }
  | { kind: 'abort-request'; requestId: string }
  | { kind: 'status' | 'cancel'; id: number };

export interface Reply { url?: string; id?: number; state?: string; error?: string; data?: string; mime?: string; exists?: boolean }

export async function request(message: Request, signal?: AbortSignal): Promise<Reply> {
  signal?.throwIfAborted();
  const cancellable = message.kind === 'asset' || message.kind === 'pdf-url' || message.kind === 'pdf-save';
  const payload = signal && cancellable ? { ...message, requestId: crypto.randomUUID() } : message;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { settled = true; signal?.removeEventListener('abort', stop); };
    const stop = () => {
      if (settled) return;
      cleanup();
      if (cancellable && 'requestId' in payload && payload.requestId) {
        try {
          void chrome.runtime.sendMessage({ kind: 'abort-request', requestId: payload.requestId })
            .catch(() => {});
        } catch { /* The reading tab or extension may already be unloading. */ }
      }
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      Promise.resolve(chrome.runtime.sendMessage(payload)).then((reply: Reply) => {
        if (settled) return;
        cleanup();
        if (!reply || reply.error) reject(new Error(reply?.error || '扩展后台未响应，请刷新阅读页'));
        else resolve(reply);
      }, error => { if (!settled) { cleanup(); reject(error); } });
    } catch (error) { cleanup(); reject(error); }
  });
}
