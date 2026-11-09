import { resourceUrl } from '../lib/hosts';
import type { Reply, Request } from '../lib/messages';
import { hasDownloadRecord, hasReaderDownloadRecord, rememberDownload, trackPdfDownload, settlePdfDownload } from '../lib/download-history';
import { BackgroundRequests } from '../lib/background-requests';

async function fetchResource(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(resourceUrl(url), {
    ...init, credentials: 'include',
    signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`资源请求失败（HTTP ${res.status}）`);
  resourceUrl(res.url);
  return res;
}

export async function handle(msg: Exclude<Request, { kind: 'abort-request' }>, signal?: AbortSignal): Promise<Reply> {
  switch (msg.kind) {
    case 'history-check':
      return { exists: await hasDownloadRecord(msg.bookId) };
    case 'history-check-reader':
      return { exists: await hasReaderDownloadRecord(msg.readerId) };
    case 'history-record':
      await rememberDownload(msg.bookId);
      return {};
    case 'pdf-url': {
      const url = new URL('https://res.weread.qq.com/cos/download');
      url.search = new URLSearchParams({ getUrl: '1', bookId: msg.bookId }).toString();
      const data = await (await fetchResource(url.href, {}, signal)).json();
      const address = data.url ?? data.data?.url;
      if (!address) throw new Error(data.errmsg || data.errMsg || '未取得原版 PDF 地址');
      return { url: resourceUrl(address).href };
    }
    case 'pdf-save': {
      // A sign-in page or an expired CDN URL can return HTTP 200.
      const res = await fetchResource(msg.url, { headers: { Range: 'bytes=0-1023' } }, signal);
      const reader = res.body!.getReader();
      let signature = '';
      try {
        while (signature.length < 5) {
          const { value, done } = await reader.read();
          if (done) break;
          signature += String.fromCharCode(...value.subarray(0, 5 - signature.length));
        }
      } finally { await reader.cancel(); }
      if (signature !== '%PDF-') throw new Error('服务器返回的内容缺少 PDF 文件头');
      signal?.throwIfAborted();
      const id = await chrome.downloads.download({ url: msg.url, filename: msg.name, conflictAction: 'uniquify' });
      if (signal?.aborted) {
        await chrome.downloads.cancel(id).catch(() => {});
        signal.throwIfAborted();
      }
      // Track pending work separately so failed retries cannot erase history.
      await trackPdfDownload(msg.bookId, id).catch(error => console.warn('无法保存下载记录', error));
      if (signal?.aborted) {
        await chrome.downloads.cancel(id).catch(() => {});
        signal.throwIfAborted();
      }
      return { id };
    }
    case 'asset': {
      let bytes: Uint8Array;
      try {
        const res = await fetchResource(msg.url, msg.retry ? { cache: 'reload' } : {}, signal);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('图片请求超时（45 秒）');
        if (error instanceof TypeError && error.message === 'Failed to fetch') throw new Error('网络请求失败，未收到图片响应');
        throw error;
      }
      if (!bytes.length) throw new Error('服务器返回了空图片');
      const mime = imageMime(bytes);
      if (!mime) throw new Error('插图资源格式无法识别');
      let data = '';
      for (let i = 0; i < bytes.length; i += 16384) data += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return { data: btoa(data), mime };
    }
    case 'status':
    case 'cancel': {
      const [item] = await chrome.downloads.search({ id: msg.id });
      if (!item || item.byExtensionId !== chrome.runtime.id) throw new Error('找不到本次下载记录');
      if (item.state !== 'in_progress') {
        await settlePdfDownload(msg.id).catch(error => console.warn('无法保存下载记录', error));
      }
      if (item.state === 'complete' && /^(text\/|application\/(json|xml))/.test(item.mime)) {
        throw new Error('下载地址已失效，服务器返回了提示页面，请重新下载');
      }
      if (msg.kind === 'cancel' && item.state === 'in_progress') await chrome.downloads.cancel(msg.id);
      return { state: item.state, error: item.state === 'interrupted' ? '下载中断：' + item.error : undefined };
    }
  }
}

function imageMime(b: Uint8Array) {
  const header = String.fromCharCode(...b.subarray(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && header.slice(1,4) === 'PNG') return 'image/png';
  if (header.startsWith('GIF8')) return 'image/gif';
  if (header.startsWith('RIFF') && header.endsWith('WEBP')) return 'image/webp';
}

export default defineBackground(() => {
  chrome.downloads.onChanged.addListener(change => {
    if (change.state?.current === 'complete' || change.state?.current === 'interrupted') {
      void settlePdfDownload(change.id).catch(error => console.warn('无法保存下载记录', error));
    }
  });
  const requests = new BackgroundRequests();
  chrome.runtime.onMessage.addListener((msg: Request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url?.startsWith('https://weread.qq.com/')) return;
    const scope = JSON.stringify([sender.tab.id, sender.documentId ?? sender.frameId]);
    if (msg.kind === 'abort-request') {
      try { requests.cancel(scope, msg.requestId); respond({}); }
      catch { respond({ error: '资源请求 ID 无效' }); }
      return;
    }
    const work = 'requestId' in msg && msg.requestId
      ? requests.run(scope, msg.requestId, signal => handle(msg, signal))
      : handle(msg);
    work.then(respond, err => respond({ error: err instanceof Error ? err.message : '下载失败' }));
    return true;
  });
});
