import type { Chapter, Reader } from './book';
import { BookRequestError, post, readBook } from './book';
import { buildContentParams, checkedBody, decodePayload } from './protocol.js';

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

export type TextFormat = 'epub' | 'txt';

interface ChapterLoadOptions {
  readerUrl?: string;
  onRetry?(attempt: number, delayMs: number): void;
  /** Injectable delays keep request-state regression tests deterministic. */
  retryDelaysMs?: readonly number[];
  sleep?: typeof wait;
}

export async function loadChapter(reader: Reader, chapter: Chapter, hint: TextFormat | undefined, signal: AbortSignal,
  options: ChapterLoadOptions = {}) {
  const delays = (options.retryDelaysMs ?? [3000, 8000]).slice(0, 2);
  const sleep = options.sleep ?? wait;
  let current = reader;
  let renewed = false;
  let failure: BookRequestError | undefined;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    if (attempt > 0) {
      const delay = Math.max(delays[attempt - 1] ?? 0, failure?.retryAfterMs ?? 0);
      options.onRetry?.(attempt, delay);
      await sleep(delay, signal);
      signal.throwIfAborted();
      if (failure?.kind === 'auth' && !renewed) {
        renewed = true;
        try { await post('/web/login/renewal', { rq: '%2Fweb%2Fbook%2Fread', ql: false }, signal); }
        catch { signal.throwIfAborted(); /* Fresh psvts below remains required. */ }
      }
    }
    try {
      if (attempt > 0 && options.readerUrl) {
        current = await readBook(options.readerUrl, signal);
        if (String(current.bookInfo.bookId) !== String(reader.bookInfo.bookId)) throw new Error('书籍已切换');
      }
      return await loadChapterOnce(current, chapter, hint, signal, sleep);
    } catch (error) {
      signal.throwIfAborted();
      const retryable = error instanceof BookRequestError &&
        (error.kind === 'transient' || error.kind === 'empty' || (error.kind === 'auth' && !!options.readerUrl));
      if (!retryable) throw error;
      if ((error.retryAfterMs ?? 0) > 30_000) {
        throw new BookRequestError(`${error.message}；服务端要求等待较长时间，请稍后重试`, error.kind, error.retryAfterMs);
      }
      if (attempt >= delays.length) {
        if (attempt > 0) throw new BookRequestError(`${error.message}（已自动重试 ${attempt} 次）`, error.kind, error.retryAfterMs);
        throw error;
      }
      failure = error;
    }
  }
}

async function loadChapterOnce(reader: Reader, chapter: Chapter, hint: TextFormat | undefined, signal: AbortSignal,
  sleep: typeof wait) {
  if (!reader.psvts) throw new Error('缺少阅读会话，请登录后刷新页面');
  const shard = async (name: string) => {
    const params = buildContentParams({ bookId: reader.bookInfo.bookId, chapterUid: chapter.chapterUid,
      psvts: reader.psvts, now: Date.now(), random: Math.random(), style: name === 'e_2' });
    const value = await post('/web/book/chapter/' + name, params, signal);
    // Empty t_1 is valid for short TXT chapters; other empty shards are retriable.
    if (name !== 't_1' && (value === '' || value === '{}')) {
      throw new BookRequestError('章节接口返回空内容，请确认登录状态和阅读权限', 'empty');
    }
    return value;
  };
  const next = async (name: string) => {
    await sleep(220, signal);
    signal.throwIfAborted();
    const value = await shard(name);
    // A short TXT chapter may have an empty second response. Service errors still propagate.
    if (name === 't_1' && (value === '' || value === '{}')) return '';
    return checkedBody(value);
  };
  let format = hint;
  let encoded = '';
  if (format !== 'txt') {
    const probe = await shard('e_0');
    if (probe.startsWith('{')) {
      const meta = JSON.parse(probe);
      if (String(meta.bookId) !== String(reader.bookInfo.bookId)) throw new Error('章节接口未返回本书正文，请确认阅读权限');
      format = 'txt';
    } else {
      format = 'epub';
      encoded = checkedBody(probe) + await next('e_1') + await next('e_3');
    }
  }
  if (format === 'txt') encoded = checkedBody(await shard('t_0')) + await next('t_1');
  const source = decodePayload(encoded);
  if (!source.trim() && chapter.wordCount !== 0) throw new Error('章节正文为空，请确认当前账号可阅读全文');
  let css = '';
  let missingStyle = false;
  if (format === 'epub') {
    try { css = decodePayload(await next('e_2')); }
    catch { signal.throwIfAborted(); missingStyle = true; }
  }
  return { format, source, css, missingStyle };
}

export function textChapter(title: string, source: string) {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  return text.split('\n', 1)[0]?.trim() === title.trim() ? text : [title, text].filter(Boolean).join('\n\n');
}
