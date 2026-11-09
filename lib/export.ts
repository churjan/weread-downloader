import { catalog, hasOriginalPdf, readBook, type Reader } from './book';
import { loadChapter, textChapter, wait, type TextFormat } from './chapters';
import { currentPdfResource, filename } from './hosts';
import { request } from './messages';
import { Epub, type ImageIssue } from './epub';

export interface DownloadStatus {
  label: string;
  detail?: string;
  chapter?: { index: number; total: number };
  warning?: boolean;
  images?: { issues: ImageIssue[]; save(): DownloadStatus };
}

interface Feedback {
  update(status: DownloadStatus): void;
  retry(text: string): Promise<void>;
}

function resourceFor(bookId: string) {
  return currentPdfResource(performance.getEntriesByType('resource').map(r => r.name), bookId);
}

async function downloadPdf(reader: Reader, cached: string | undefined, signal: AbortSignal, ui: Feedback) {
  const book = reader.bookInfo;
  ui.update({ label: '正在获取原版 PDF…', detail: book.title });
  let id: number | undefined;
  const start = async (url: string) => {
    signal.throwIfAborted();
    const reply = await request({ kind: 'pdf-save', url, name: filename(book.title, 'pdf'), bookId: String(book.bookId) }, signal);
    if (reply.id == null) throw new Error('Chrome 未创建下载任务');
    id = reply.id;
  };
  try {
    try {
      const url = (await request({ kind: 'pdf-url', bookId: book.bookId }, signal)).url;
      if (!url) throw new Error('未取得原版 PDF 地址');
      await start(url);
    } catch (error) {
      signal.throwIfAborted();
      const fallback = reader.pdfUrl || cached;
      if (!fallback) throw error;
      await start(fallback);
    }
    ui.update({ label: 'PDF 下载中', detail: book.title });
    while (true) {
      signal.throwIfAborted();
      if ((await request({ kind: 'status', id: id! }, signal)).state === 'complete') break;
      await wait(550, signal);
    }
  } finally {
    if (signal.aborted && id != null) await request({ kind: 'cancel', id }).catch(() => {});
  }
  return { label: 'PDF 下载完成', detail: book.title };
}

function saveLocal(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadBook(url: string, signal: AbortSignal, ui: Feedback): Promise<DownloadStatus> {
  ui.update({ label: '正在识别书籍格式…' });
  let reader = await readBook(url, signal);
  const book = reader.bookInfo;
  signal.throwIfAborted();
  const cached = resourceFor(String(book.bookId));
  if (cached || reader.pdfUrl || hasOriginalPdf(book)) return downloadPdf(reader, cached, signal, ui);
  const { chapters, format: catalogFormat } = await catalog(book.bookId, signal);
  const hint = (catalogFormat || book.format || '').toLowerCase();
  if (hint === 'pdf') return downloadPdf(reader, cached, signal, ui);
  if (hint && hint !== 'txt' && hint !== 'epub') throw new Error('暂不支持此格式：' + hint);
  let format: TextFormat | undefined = hint === 'txt' || hint === 'epub' ? hint : undefined;
  const epub = new Epub(book.cover);
  const text: string[] = [];
  for (const [i, chapter] of chapters.entries()) {
    const title = chapter.title || '第 ' + (i + 1) + ' 章';
    let refresh = i > 0;
    for (;;) {
      signal.throwIfAborted();
      ui.update({ label: format ? format.toUpperCase() + ' 下载中' : '正在读取章节',
        detail: title, chapter: { index: i + 1, total: chapters.length } });
      try {
        if (refresh) {
          reader = await readBook(url, signal);
          if (String(reader.bookInfo.bookId) !== String(book.bookId)) throw new Error('书籍已切换');
        }
        const ch = await loadChapter(reader, chapter, format, signal, {
          readerUrl: url,
          onRetry(attempt, delayMs) {
            ui.update({ label: '正在重试章节', detail: `${title} · 第 ${attempt} 次重试，${delayMs / 1000} 秒后继续`,
              chapter: { index: i + 1, total: chapters.length } });
          },
        });
        if (i && format !== ch.format) throw new Error('章节格式与已读章节不一致');
        if (ch.format === 'txt') text.push(textChapter(title, ch.source));
        else {
          if (ch.source && !/<[a-z][\s\S]*>/i.test(ch.source)) throw new Error('无法识别 EPUB 正文');
          await epub.add(title, ch.source, ch.css, signal);
          if (ch.missingStyle) epub.missingStyles++;
        }
        format = ch.format;
        break;
      } catch (e) {
        signal.throwIfAborted();
        await ui.retry(`《${title}》读取失败：${e instanceof Error ? e.message : '未知错误'}`);
        refresh = true;
      }
    }
    if (i + 1 < chapters.length) await wait(1500, signal);
  }
  signal.throwIfAborted();
  if (format === 'txt') {
    saveLocal(new Blob([text.join('\n\n')], { type: 'text/plain;charset=utf-8' }), filename(book.title,'txt'));
    await recordExport();
    return { label: 'TXT 已提交下载', detail: book.title };
  }
  ui.update({ label: '正在打包 EPUB…', detail: book.title });
  await wait(30, signal);
  await epub.loadCover(book, signal);
  function save(repaired: boolean): DownloadStatus {
    const data = epub.build(book, signal);
    const name = repaired ? book.title + '（修复版）' : book.title;
    saveLocal(new Blob([new Uint8Array(data)], { type: 'application/epub+zip' }), filename(name,'epub'));
    const warnings = [];
    const missing = epub.issues.filter(issue => !issue.repaired && issue.kind !== 'resource').length;
    const unsupported = epub.issues.filter(issue => !issue.repaired && issue.kind === 'resource').length;
    if (missing) warnings.push(`${missing} 处插图缺失`);
    if (unsupported) warnings.push(`${unsupported} 处资源未保留`);
    if (epub.missingStyles) warnings.push(`${epub.missingStyles} 章样式缺失`);
    return {
      label: repaired ? '修复版 EPUB 已提交下载' : 'EPUB 已提交下载',
      detail: warnings.join(' · ') || book.title,
      warning: warnings.length > 0,
      images: missing || unsupported ? { issues: epub.issues, save: () => save(true) } : undefined,
    };
  }
  const result = save(false);
  await recordExport();
  return result;

  async function recordExport() {
    await request({ kind: 'history-record', bookId: String(book.bookId) })
      .catch(error => console.warn('无法保存下载记录', error));
  }
}
