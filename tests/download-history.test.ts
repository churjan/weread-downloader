import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { hasDownloadRecord, hasReaderDownloadRecord, rememberDownload, trackPdfDownload, settlePdfDownload } from '../lib/download-history';
import { downloadBook } from '../lib/export';
import { md5Hex, wereadE } from '../lib/protocol.js';
import type { Request } from '../lib/messages';

function installChrome(t: TestContext, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else Reflect.deleteProperty(globalThis, 'chrome');
  });
}

test('导出历史按书籍 ID 持久保存，不混淆同名书籍', async t => {
  const data: Record<string, unknown> = {};
  installChrome(t, {
    storage: { local: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(data, structuredClone(values)),
    } },
  });
  assert.equal(await hasDownloadRecord('123'), false);
  await rememberDownload('123');
  assert.equal(await hasDownloadRecord('123'), true);
  assert.equal(await hasDownloadRecord('456'), false);
});

test('直接通过阅读页标识查询已有下载记录，无需先请求书籍网页', async t => {
  const data: Record<string, unknown> = {
    'download-history:123': { submittedAt: 123 },
    'download-history:CB_test': { submittedAt: 456 },
    'download-pending:42': { bookId: '789' },
  };
  installChrome(t, { storage: { local: {
    get: async (key: string | null) => key === null ? { ...data } : { [key]: data[key] },
  } } });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('本地记录查询不应发出网页请求'); });
  assert.equal(await hasReaderDownloadRecord(wereadE('123')), true);
  assert.equal(await hasReaderDownloadRecord(wereadE('CB_test')), true);
  assert.equal(await hasReaderDownloadRecord(wereadE('456')), false);
  assert.equal(await hasReaderDownloadRecord(wereadE('789')), false);
});

test('阅读页历史查询继续校验记录内容，不把损坏记录误当作已下载', async t => {
  const data: Record<string, unknown> = { 'download-history:123': { submittedAt: 'invalid' } };
  installChrome(t, { storage: { local: {
    get: async (key: string | null) => key === null ? { ...data } : { [key]: data[key] },
  } } });
  assert.equal(await hasReaderDownloadRecord(wereadE('123')), false);
});

function pdfFixture(t: TestContext) {
  const data: Record<string, unknown> = {};
  let items: Partial<chrome.downloads.DownloadItem>[] = [];
  installChrome(t, {
    runtime: { id: 'test-extension' },
    storage: { local: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(data, structuredClone(values)),
      remove: async (key: string) => { delete data[key]; },
    } },
    downloads: { search: async () => items },
  });
  return { data, setItems(value: Partial<chrome.downloads.DownloadItem>[]) { items = value; } };
}

test('PDF 完成后历史持久保存，删除文件或清空浏览器任务记录仍可重新下载', async t => {
  const fixture = pdfFixture(t);
  const item = { id: 42, byExtensionId: 'test-extension', mime: 'application/pdf' };
  fixture.setItems([{ ...item, state: 'in_progress' }]);
  await trackPdfDownload('pdf-book', 42);
  assert.equal(await hasDownloadRecord('pdf-book'), false);
  fixture.setItems([{ ...item, state: 'complete' }]);
  await settlePdfDownload(42);
  assert.equal(await hasDownloadRecord('pdf-book'), true);
  fixture.setItems([{ ...item, state: 'complete', exists: false }]);
  assert.equal(await hasDownloadRecord('pdf-book'), true);
  fixture.setItems([]);
  assert.equal(await hasDownloadRecord('pdf-book'), true);
  assert.equal(fixture.data['download-pending:42'], undefined);
});

test('PDF 重下失败不覆盖旧记录，首次失败不记作已下载', async t => {
  const fixture = pdfFixture(t);
  await rememberDownload('old-book');
  const old = structuredClone(fixture.data['download-history:old-book']);
  fixture.setItems([{ id: 42, state: 'in_progress' }]);
  await trackPdfDownload('old-book', 42);
  await trackPdfDownload('new-book', 43);
  fixture.setItems([{ id: 42, state: 'interrupted' }]);
  await settlePdfDownload(42);
  await settlePdfDownload(43);
  assert.deepEqual(fixture.data['download-history:old-book'], old);
  assert.equal(await hasDownloadRecord('old-book'), true);
  assert.equal(await hasDownloadRecord('new-book'), false);
});

test('PDF 完成事件早于任务登记时仍会写入历史，失效响应不会记入', async t => {
  const fixture = pdfFixture(t);
  fixture.setItems([{ id: 42, state: 'complete', byExtensionId: 'test-extension', mime: 'application/pdf' }]);
  await trackPdfDownload('good', 42);
  assert.equal(await hasDownloadRecord('good'), true);
  fixture.setItems([{ id: 43, state: 'complete', byExtensionId: 'test-extension', mime: 'text/html' }]);
  await trackPdfDownload('expired', 43);
  assert.equal(await hasDownloadRecord('expired'), false);
  fixture.setItems([{ id: 44, state: 'complete', byExtensionId: 'other-extension', mime: 'application/pdf' }]);
  await trackPdfDownload('foreign', 44);
  assert.equal(await hasDownloadRecord('foreign'), false);
});

test('旧版 PDF 记录在完成后迁移，不再依赖浏览器保留下载任务', async t => {
  const fixture = pdfFixture(t);
  fixture.data['download-history:legacy'] = { submittedAt: 123, downloadId: 42 };
  fixture.setItems([{ id: 42, state: 'in_progress', byExtensionId: 'test-extension', mime: 'application/pdf' }]);
  assert.equal(await hasDownloadRecord('legacy'), false);
  fixture.setItems([{ id: 42, state: 'complete', byExtensionId: 'test-extension', mime: 'application/pdf' }]);
  assert.equal(await hasDownloadRecord('legacy'), true);
  fixture.setItems([]);
  assert.equal(await hasDownloadRecord('legacy'), true);
});

function exportFixture(t: TestContext, fail = false) {
  const messages: Request[] = [];
  const fetched: string[] = [];
  let saves = 0;
  installChrome(t, { runtime: { sendMessage: async (message: Request) => {
    messages.push(message);
    if (message.kind === 'history-record') assert.ok(saves > 0, '提交文件后才写入历史');
    return {};
  } } });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    fetched.push(url);
    if (url.startsWith('https://')) return new Response('<script>window.__INITIAL_STATE__ = ' +
      JSON.stringify({ reader: { bookInfo: { bookId: '123', title: '样本', format: 'txt' }, psvts: 'session' } }) + ';</script>');
    if (url.endsWith('chapterInfos')) return new Response(JSON.stringify([
      { bookId: '123', format: 'txt', chapters: [{ chapterUid: 1, title: 'A', wordCount: 1 }] },
    ]));
    if (fail) throw new Error('网络中断');
    return new Response(url.endsWith('t_0') ? md5Hex('Z==QQ') + 'Z==QQ' : '');
  });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { append() {} },
    createElement: () => ({ click() { saves++; }, remove() {} }),
  } });
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const timeout = globalThis.setTimeout;
  // Revoke the test Blob URL immediately instead of leaving a 60-second timer.
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms: number) => timeout(fn, ms === 60_000 ? 0 : ms));
  const controller = new AbortController();
  const ui = {
    update() {},
    retry: async () => { controller.abort(new Error('用户取消')); throw controller.signal.reason; },
  };
  return {
    run: () => downloadBook('https://weread.qq.com/web/reader/book', controller.signal, ui),
    messages, fetched,
    get saves() { return saves; },
  };
}

test('首次下载直接导出，提交文件后才记入历史', async t => {
  const fixture = exportFixture(t);
  const result = await fixture.run();
  assert.equal(result?.label, 'TXT 已提交下载');
  assert.equal(fixture.saves, 1);
  assert.deepEqual(fixture.messages.map(message => message.kind), ['history-record']);
});

test('重复下载直接生成文件，不再查询历史或要求二次确认', async t => {
  const fixture = exportFixture(t);
  assert.equal((await fixture.run())?.label, 'TXT 已提交下载');
  assert.equal((await fixture.run())?.label, 'TXT 已提交下载');
  assert.equal(fixture.saves, 2);
  assert.deepEqual(fixture.messages.map(message => message.kind), ['history-record', 'history-record']);
});

test('章节读取失败后取消，不生成文件或写入下载历史', async t => {
  const fixture = exportFixture(t, true);
  await assert.rejects(fixture.run(), /用户取消/);
  assert.equal(fixture.saves, 0);
  assert.deepEqual(fixture.messages, []);
});
