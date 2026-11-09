export interface BookInfo {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  type?: number;
  format?: string;
  otherType?: { format?: string; type?: number; bookId?: string }[];
}

export interface Reader {
  bookInfo: BookInfo;
  psvts?: string;
  pdfUrl?: string;
}

export interface Chapter {
  chapterUid: number;
  chapterIdx?: number;
  title: string;
  wordCount?: number;
  level?: number;
}

export type RequestFailure = 'transient' | 'auth' | 'permanent' | 'empty';

export class BookRequestError extends Error {
  constructor(message: string, readonly kind: RequestFailure, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'BookRequestError';
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

async function bookFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  try {
    const response = await fetch(url, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok) {
      const status = response.status;
      const kind = status === 401 ? 'auth' : status === 408 || status === 429 || status >= 500 ? 'transient' : 'permanent';
      throw new BookRequestError(`微信读书请求失败（HTTP ${status}）`, kind, retryAfter(response.headers.get('Retry-After')));
    }
    return response;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BookRequestError) throw error;
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new BookRequestError(error instanceof TypeError ? '网络请求失败，请检查网络连接' : '微信读书请求超时', 'transient');
    }
    throw error;
  }
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  try { return await response.text(); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new BookRequestError('读取微信读书响应失败，请检查网络连接', 'transient');
    }
    throw error;
  }
}

export function hasOriginalPdf(book: BookInfo): boolean {
  return Number(book.type) === 11 || book.format?.toLowerCase() === 'pdf' ||
    (Array.isArray(book.otherType) && book.otherType.some(item => Number(item?.type) === 11 || item?.format?.toLowerCase() === 'pdf'));
}

export async function readBook(url: string, signal: AbortSignal): Promise<Reader> {
  const res = await bookFetch(url, { credentials: 'same-origin', cache: 'no-store' }, signal);
  const html = await readResponseText(res, signal);
  const raw = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:\(function|<\/script>)/)?.[1];
  const reader = raw && JSON.parse(raw).reader;
  if (!reader?.bookInfo?.bookId || !reader.bookInfo.title) throw new Error('当前页面未提供书籍信息，请登录并打开阅读页');
  return reader;
}

export async function post(path: string, data: unknown, signal: AbortSignal): Promise<string> {
  const res = await bookFetch(path, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(data) }, signal);
  const text = (await readResponseText(res, signal)).trim();
  if (text.startsWith('{')) {
    const json = JSON.parse(text);
    const code = json.errCode || json.errcode;
    if ([-2010, -2012].includes(Number(code))) throw new BookRequestError('请登录微信读书后重试', 'auth');
    if (code) throw new BookRequestError(`${json.errMsg || json.errmsg || '微信读书接口错误'}（${code}）`, 'permanent');
  }
  return text;
}

export async function catalog(bookId: string, signal: AbortSignal): Promise<{format?: string; chapters: Chapter[]}> {
  const payload = JSON.parse(await post('/web/book/chapterInfos', { bookIds: [bookId] }, signal));
  const records = Array.isArray(payload) ? payload : payload.data ?? payload.books ?? [payload];
  const record = Array.isArray(records) && records.find(r => String(r.bookId ?? r.book?.bookId) === String(bookId));
  const rows: Chapter[] = record?.updated ?? record?.chapterInfos ?? record?.chapters;
  if (!Array.isArray(rows) || !rows.length) throw new Error('未获取到这本书的完整目录');
  const seen = new Set<number>();
  const chapters = rows.filter(ch => {
    if (!Number.isInteger(ch.chapterUid) || seen.has(ch.chapterUid)) return false;
    seen.add(ch.chapterUid);
    return true;
  }).sort((a,b) => (a.chapterIdx ?? 0) - (b.chapterIdx ?? 0));
  if (!chapters.length) throw new Error('目录中没有可读取的章节');
  return { format: record.format ?? record.book?.format, chapters };
}
