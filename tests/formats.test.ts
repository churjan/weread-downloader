import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasOriginalPdf } from '../lib/book';
import { currentPdfResource, filename, resourceUrl } from '../lib/hosts';
import { loadChapter, textChapter } from '../lib/chapters';
import { buildContentParams, checkedBody, decodePayload, md5Hex, wereadE } from '../lib/protocol.js';

test('文字视图也优先识别原版 PDF', () => {
  const book = { title: 'test', bookId: 'CB_test', format: 'epub' };
  assert.equal(hasOriginalPdf({ ...book, type: 11 }), true);
  assert.equal(hasOriginalPdf({ ...book, otherType: [{ format: 'pdf' }] }), true);
  assert.equal(hasOriginalPdf(book), false);
});

test('切书后只取当前书 PDF，保留签名参数并拒绝站外地址', () => {
  const base = 'https://wrco-40036.sh.gfp.tencent-cloud.com/';
  assert.equal(currentPdfResource([base+'CB_b.pdf', base+'CB_a.pdf?key=2'], 'CB_a'), base+'CB_a.pdf?key=2');
  assert.equal(currentPdfResource([base+'CB_b.pdf'], 'CB_a'), undefined);
  assert.throws(() => resourceUrl('https://weread.qq.com.example.com/a.png'));
  assert.throws(() => resourceUrl('http://res.weread.qq.com/x'));
});

test('TXT 保留段落并避免重复标题，文件名可用于 Windows', () => {
  assert.equal(textChapter('第一章', '\uFEFF第一章\r\n甲\r\n\r\n乙'), '第一章\n甲\n\n乙');
  assert.equal(textChapter('第二章', '丙'), '第二章\n\n丙');
  assert.equal(filename('书/名?', 'txt'), '书_名_.txt');
  assert.equal(filename('CON', 'pdf'), '_CON.pdf');
});

test('阅读器的签名和校验向量', () => {
  assert.equal(wereadE('43208843'), 'c9c321c07293508bc9c79df');
  const params = buildContentParams({ bookId: '43208843', chapterUid: 42, psvts: 'abc', now: 1756500000000, random: 0.0099 });
  assert.equal(params.s, '961407fa');
  assert.equal(checkedBody(md5Hex('')), '');
  assert.throws(() => checkedBody('{}'));
  assert.throws(() => checkedBody(md5Hex('a')+'b'));
  assert.equal(decodePayload('Z==QQ'), 'A');
});

test('短 TXT 章节可以只有第一个分片，但不会吞掉第二个分片的登录错误', async t => {
  let second = '{}';
  const first = 'Z==QQ';
  const reader = { bookInfo: { title: '样本', bookId: '123' }, psvts: 'session' };
  const chapter = { chapterUid: 1, title: 'A', wordCount: 1 };
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    new Response(url.endsWith('/t_0') ? md5Hex(first) + first : second));
  const signal = new AbortController().signal;
  assert.equal((await loadChapter(reader, chapter, 'txt', signal)).source, 'A');
  second = '{"errCode":-2012}';
  await assert.rejects(loadChapter(reader, chapter, 'txt', signal), /登录/);
});
