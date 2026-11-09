import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Request } from '../lib/messages';
import { BackgroundRequests } from '../lib/background-requests';

// WXT supplies this wrapper at runtime; importing the handler must not install a worker in Node.
Object.defineProperty(globalThis, 'defineBackground', { configurable: true, value: () => undefined });
const { handle } = await import('../entrypoints/background');

function installChrome(t: TestContext, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else Reflect.deleteProperty(globalThis, 'chrome');
  });
}

test('取消未返回的资源消息立即结束本地等待，并发送同 ID 的取消消息', async t => {
  const sent: Request[] = [];
  let lateReject!: (error: Error) => void;
  installChrome(t, { runtime: { sendMessage: (message: Request) => {
    sent.push(message);
    return message.kind === 'asset' ? new Promise((_, reject) => { lateReject = reject; }) : Promise.resolve({});
  } } });
  const controller = new AbortController();
  const task = request({ kind: 'asset', url: 'https://res.weread.qq.com/a.png' }, controller.signal);
  controller.abort(new Error('用户取消'));
  await assert.rejects(task, /用户取消/);
  assert.equal(sent.length, 2);
  const first = sent[0]!;
  const second = sent[1]!;
  assert.equal(first.kind, 'asset');
  assert.equal(second.kind, 'abort-request');
  assert.equal('requestId' in first && first.requestId, 'requestId' in second && second.requestId);
  // A late background rejection is observed rather than becoming unhandled.
  lateReject(new Error('后台已终止'));
  await Promise.resolve();
});

test('已取消的任务不发送任何新消息', async t => {
  let sent = 0;
  installChrome(t, { runtime: { sendMessage: async () => { sent++; return {}; } } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request({ kind: 'asset', url: 'https://res.weread.qq.com/a.png' }, controller.signal), { name: 'AbortError' });
  assert.equal(sent, 0);
});

test('后台取消按文档隔离，同 ID 的另一标签页不受影响', async () => {
  const registry = new BackgroundRequests();
  let finishOther!: () => void;
  let otherSignal!: AbortSignal;
  const first = registry.run('tab-1-document', 'same-id', signal => new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const other = registry.run('tab-2-document', 'same-id', signal => new Promise<void>(resolve => {
    otherSignal = signal;
    finishOther = resolve;
  }));
  registry.cancel('tab-1-document', 'same-id');
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(otherSignal.aborted, false);
  finishOther();
  await other;
});

test('取消消息先到时，后台也不会开始旧请求', async () => {
  const registry = new BackgroundRequests();
  registry.cancel('document', 'pending-id');
  let started = false;
  await assert.rejects(registry.run('document', 'pending-id', async () => { started = true; }), { name: 'AbortError' });
  assert.equal(started, false);
});

test('请求结束后后台清理控制器，不保留旧的活跃请求', async () => {
  const registry = new BackgroundRequests();
  await assert.rejects(registry.run('document', 'id', async () => { throw new Error('网络错误'); }), /网络错误/);
  assert.equal(await registry.run('document', 'id', async () => 42), 42);
});

test('后台图片 fetch 收到取消信号后中止', async t => {
  let backgroundSignal!: AbortSignal;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    backgroundSignal = init.signal!;
    return new Promise<Response>((_, reject) => {
      backgroundSignal.addEventListener('abort', () => reject(backgroundSignal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const task = handle({ kind: 'asset', url: 'https://res.weread.qq.com/a.png' }, controller.signal);
  controller.abort(new DOMException('已取消下载', 'AbortError'));
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(backgroundSignal.aborted, true);
});

test('PDF 创建任务期间取消，收到下载 ID 后取消它且不写入历史', async t => {
  const pdf = new Response('%PDF-1.7\n');
  Object.defineProperty(pdf, 'url', { value: 'https://res.weread.qq.com/book.pdf' });
  t.mock.method(globalThis, 'fetch', async () => pdf);
  let created!: (id: number) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled: number[] = [];
  let recorded = false;
  installChrome(t, {
    downloads: {
      download: () => { started(); return new Promise<number>(resolve => { created = resolve; }); },
      cancel: async (id: number) => { cancelled.push(id); },
    },
    storage: { local: { set: async () => { recorded = true; } } },
  });
  const controller = new AbortController();
  const task = handle({ kind: 'pdf-save', url: pdf.url, name: 'book.pdf', bookId: 'book' }, controller.signal);
  await ready;
  controller.abort(new DOMException('已取消下载', 'AbortError'));
  created(123);
  await assert.rejects(task, { name: 'AbortError' });
  assert.deepEqual(cancelled, [123]);
  assert.equal(recorded, false);
});
