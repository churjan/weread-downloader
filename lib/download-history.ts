import { wereadE } from './protocol.js';

interface DownloadRecord {
  submittedAt: number;
  downloadId?: number;
}

const historyPrefix = 'download-history:';
const keyFor = (bookId: string) => historyPrefix + bookId;
const pendingKey = (id: number) => 'download-pending:' + id;

export async function rememberDownload(bookId: string) {
  const record: DownloadRecord = { submittedAt: Date.now() };
  await chrome.storage.local.set({ [keyFor(bookId)]: record });
}

function validPdf(item: chrome.downloads.DownloadItem) {
  return item.byExtensionId === chrome.runtime.id &&
    !/^(text\/|application\/(json|xml))/.test(item.mime);
}

export async function settlePdfDownload(id: number) {
  const key = pendingKey(id);
  const pending = (await chrome.storage.local.get(key))[key] as { bookId: string } | undefined;
  if (!pending?.bookId) return;
  const [item] = await chrome.downloads.search({ id });
  if (item?.state === 'in_progress') return;
  if (item?.state === 'complete' && validPdf(item)) await rememberDownload(pending.bookId);
  // A failed attempt never replaces an earlier successful record.
  await chrome.storage.local.remove(key);
}

export async function trackPdfDownload(bookId: string, id: number) {
  await chrome.storage.local.set({ [pendingKey(id)]: { bookId } });
  // Completion can arrive before the pending record was stored.
  await settlePdfDownload(id);
}

export async function hasDownloadRecord(bookId: string): Promise<boolean> {
  const key = keyFor(bookId);
  const record = (await chrome.storage.local.get(key))[key] as DownloadRecord | undefined;
  if (!record || !Number.isFinite(record.submittedAt)) return false;
  // History describes an export, independently of whether its file still exists.
  if (record.downloadId == null) return true;
  // Migrate older PDF records once Chrome confirms completion.
  const [item] = await chrome.downloads.search({ id: record.downloadId });
  if (!item || !validPdf(item)) return false;
  if (item.state === 'complete') {
    await rememberDownload(bookId);
    return true;
  }
  if (item.state === 'in_progress') await trackPdfDownload(bookId, item.id);
  return false;
}

export async function hasReaderDownloadRecord(readerId: string): Promise<boolean> {
  const records = await chrome.storage.local.get(null);
  const key = Object.keys(records).find(key => key.startsWith(historyPrefix) &&
    wereadE(key.slice(historyPrefix.length)) === readerId);
  return key ? hasDownloadRecord(key.slice(historyPrefix.length)) : false;
}
