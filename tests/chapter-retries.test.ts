import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BookRequestError, post, type Reader } from '../lib/book';
import { loadChapter, wait } from '../lib/chapters';
import { md5Hex } from '../lib/protocol.js';

const reader: Reader = { bookInfo: { bookId: '123', title: '样本' }, psvts: 'old-session' };
const chapter = { chapterUid: 42, title: '章', wordCount: 1 };
const checked = (body: string) => md5Hex(body) + body;
const noWait = async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); };
const readerHtml = (psvts = 'fresh-session', bookId = '123') => '<script>window.__INITIAL_STATE__ = ' +
  JSON.stringify({ reader: { bookInfo: { bookId, title: '样本' }, psvts } }) + ';</script>';

test('短暂网络失败只重试失败章节，并重新生成分片签名', async t => {
  const params: { ps: string; r: string }[] = [];
  const delays: number[] = [];
  let t0 = 0;
  let random = 0;
  t.mock.method(Math, 'random', () => (random += 0.001));
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://')) return new Response(readerHtml());
    if (url.endsWith('t_0')) {
      params.push(JSON.parse(String(init?.body)));
      if (++t0 === 1) throw new TypeError('Failed to fetch');
      return new Response(checked('Z==QQ'));
    }
    return new Response('');
  });
  const result = await loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    readerUrl: 'https://weread.qq.com/web/reader/sample',
    sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); },
  });
  assert.equal(result.source, 'A');
  assert.equal(t0, 2);
  assert.deepEqual(params.map(value => value.ps), ['old-session', 'fresh-session']);
  assert.notEqual(params[0]!.r, params[1]!.r);
  assert.deepEqual(delays, [3000, 220]);
});

test('持续空分片最多尝试三次，退避为 3 秒与 8 秒', async t => {
  let count = 0;
  const delays: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response('{}'); });
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); },
  }), error => error instanceof BookRequestError && error.kind === 'empty');
  assert.equal(count, 3);
  assert.deepEqual(delays, [3000, 8000]);
});

test('登录失效最多续期一次，并从阅读页获取新会话再签名', async t => {
  const calls: string[] = [];
  const sessions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('renewal')) return new Response('{"succ":1}');
    if (url.startsWith('https://')) return new Response(readerHtml());
    if (url.endsWith('t_0')) sessions.push(JSON.parse(String(init?.body)).ps);
    return new Response('{"errcode":-2012}');
  });
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    readerUrl: 'https://weread.qq.com/web/reader/sample', sleep: noWait,
  }), /登录/);
  assert.equal(calls.filter(url => url.endsWith('renewal')).length, 1);
  assert.deepEqual(sessions, ['old-session', 'fresh-session', 'fresh-session']);
});

test('无阅读权限和完整性校验失败不自动重试', async t => {
  let count = 0;
  let response = '{"errCode":-2001,"errMsg":"无阅读权限"}';
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response(response); });
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, { sleep: noWait }), /无阅读权限/);
  assert.equal(count, 1);
  response = checked('Z==QQ') + 'corrupt';
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, { sleep: noWait }), /校验失败/);
  assert.equal(count, 2);
});

test('HTTP 429 按 Retry-After 等待 10 秒后重试', async t => {
  let count = 0;
  const delays: number[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('t_0') && count++ === 0) return new Response('', { status: 429, headers: { 'Retry-After': '10' } });
    return new Response(url.endsWith('t_0') ? checked('Z==QQ') : '');
  });
  assert.equal((await loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); },
  })).source, 'A');
  assert.deepEqual(delays, [10_000, 220]);
});

test('HTTP 429 要求等待超过 30 秒时提示稍后手动重试，不提前请求', async t => {
  let requests = 0;
  const delays: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  });
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); },
  }), error => error instanceof BookRequestError && error.retryAfterMs === 120_000 && /服务端要求等待较长时间，请稍后重试/.test(error.message));
  assert.equal(requests, 1);
  assert.deepEqual(delays, []);
});

test('HTTP 403 不重试，HTTP 503 和超时被归类为临时错误', async t => {
  let response: () => Promise<Response> = async () => new Response('', { status: 403 });
  t.mock.method(globalThis, 'fetch', () => response());
  const signal = new AbortController().signal;
  await assert.rejects(post('/path', {}, signal), error => error instanceof BookRequestError && error.kind === 'permanent');
  response = async () => new Response('', { status: 503 });
  await assert.rejects(post('/path', {}, signal), error => error instanceof BookRequestError && error.kind === 'transient');
  response = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  await assert.rejects(post('/path', {}, signal), error => error instanceof BookRequestError && error.kind === 'transient');
});

test('退避期间取消会立即结束，不续期或发出后续请求', async t => {
  let requests = 0;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{}'); });
  const controller = new AbortController();
  const task = loadChapter(reader, chapter, 'txt', controller.signal, {
    sleep: async (ms, signal) => { entered(); await wait(ms, signal); },
  });
  const rejected = assert.rejects(task, /用户取消/);
  await waiting;
  controller.abort(new Error('用户取消'));
  await rejected;
  assert.equal(requests, 1);
});

test('会话刷新若切换到其他书籍，不继续请求正文', async t => {
  let shards = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.startsWith('https://')) return new Response(readerHtml('fresh', '456'));
    shards++;
    return new Response('{}');
  });
  await assert.rejects(loadChapter(reader, chapter, 'txt', new AbortController().signal, {
    readerUrl: 'https://weread.qq.com/web/reader/sample', sleep: noWait,
  }), /书籍已切换/);
  assert.equal(shards, 1);
});

test('合法 TXT 元信息和空 t_1 不触发重试', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return new Response(url.endsWith('e_0') ? '{"bookId":"123"}' : url.endsWith('t_0') ? checked('Z==QQ') : '{}');
  });
  const result = await loadChapter(reader, chapter, undefined, new AbortController().signal, { sleep: noWait });
  assert.equal(result.format, 'txt');
  assert.equal(result.source, 'A');
  assert.equal(calls.length, 3);
});

test('可选 e_2 样式失败不引发整章自动重试', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    const shard = url.split('/').pop();
    if (shard === 'e_2') return new Response('', { status: 503 });
    return new Response(checked(shard === 'e_0' ? 'Z' : shard === 'e_1' ? '==' : 'QQ'));
  });
  const result = await loadChapter(reader, chapter, 'epub', new AbortController().signal, { sleep: noWait });
  assert.equal(result.source, 'A');
  assert.equal(result.missingStyle, true);
  assert.equal(calls.length, 4);
});
