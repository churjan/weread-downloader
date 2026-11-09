import { downloadBook, type DownloadStatus } from '../lib/export';
import downloadIcon from 'bootstrap-icons/icons/download.svg?raw';
import repeatIcon from 'bootstrap-icons/icons/arrow-clockwise.svg?raw';
import closeIcon from 'bootstrap-icons/icons/x.svg?raw';
import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg?raw';
import failureIcon from 'bootstrap-icons/icons/x-circle-fill.svg?raw';
import warningIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg?raw';
import styles from '../lib/download-pill.css?inline';
import { imageDetails } from '../lib/image-details';
import { request } from '../lib/messages';

type Phase = 'idle' | 'running' | 'retry' | 'done' | 'failed' | 'cancelled';

export default defineContentScript({
  matches: ['https://weread.qq.com/*'],
  main(ctx) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${styles}</style>
      <button type="button" class="start" hidden></button>
      <section class="pill" hidden>
        <span class="symbol" aria-hidden="true"></span>
        <output aria-live="polite" aria-atomic="true"><span class="headline"><strong></strong><span class="count"></span></span><span class="detail"></span><button type="button" class="inspect" aria-expanded="false" aria-controls="image-details" hidden></button></output>
        <button type="button" class="retry" hidden></button>
        <button type="button" class="close"><span aria-hidden="true">${closeIcon}</span></button>
      </section>`;
    const start = root.querySelector<HTMLButtonElement>('.start')!;
    const pill = root.querySelector('section')!;
    const symbol = root.querySelector<HTMLElement>('.symbol')!;
    const label = root.querySelector('strong')!;
    const count = root.querySelector<HTMLElement>('.count')!;
    const detail = root.querySelector<HTMLElement>('.detail')!;
    const again = root.querySelector<HTMLButtonElement>('.retry')!;
    const close = root.querySelector<HTMLButtonElement>('.close')!;
    const images = imageDetails(root, result => {
      show('done', result);
      (result.images ? images.toggle : close).focus();
    });

    let controller: AbortController | undefined;
    let resume: (() => void) | undefined;
    let currentBook = '';
    let downloaded: boolean | undefined;
    let historyController: AbortController | undefined;
    let historyVersion = 0;
    let autoCloseTimer: number | undefined;
    let autoCloseRemaining: number | undefined;
    let autoCloseStarted = 0;

    function updateStart() {
      start.hidden = pill.dataset.phase !== 'idle' || downloaded === undefined;
      if (downloaded !== undefined) {
        start.innerHTML = `<span aria-hidden="true">${downloaded ? repeatIcon : downloadIcon}</span>${downloaded ? '重新下载' : '下载本书'}`;
      }
    }
    async function loadHistory(book: string) {
      historyController?.abort();
      const job = new AbortController();
      historyController = job;
      const version = ++historyVersion;
      try {
        const history = await request({ kind: 'history-check-reader', readerId: book }, job.signal);
        if (ctx.isValid && currentBook === book && historyVersion === version) {
          downloaded = !!history.exists;
          updateStart();
        }
      } catch {
        if (ctx.isValid && currentBook === book && historyVersion === version && downloaded === undefined) {
          // A failed history lookup must still leave a usable download button.
          downloaded = false;
          updateStart();
        }
      }
      finally { if (historyController === job) historyController = undefined; }
    }
    const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && currentBook && Object.keys(changes).some(key => key.startsWith('download-history:'))) {
        void loadHistory(currentBook);
      }
    };
    chrome.storage.onChanged.addListener(storageChanged);

    function pauseAutoClose() {
      if (autoCloseTimer === undefined) return;
      window.clearTimeout(autoCloseTimer);
      autoCloseTimer = undefined;
      autoCloseRemaining = Math.max(0, (autoCloseRemaining ?? 0) - (performance.now() - autoCloseStarted));
    }
    function updateAutoClose() {
      pauseAutoClose();
      if (pill.dataset.phase !== 'done' || document.hidden || !document.hasFocus()
        || host.matches(':hover') || root.activeElement || autoCloseRemaining === undefined) return;
      autoCloseStarted = performance.now();
      autoCloseTimer = ctx.setTimeout(() => {
        autoCloseTimer = undefined;
        reset();
      }, autoCloseRemaining);
    }

    function show(phase: Phase, status: DownloadStatus) {
      pauseAutoClose();
      autoCloseRemaining = phase === 'done' && !status.warning && !status.images ? 5000 : undefined;
      pill.hidden = phase === 'idle';
      pill.dataset.phase = phase;
      updateStart();
      pill.classList.toggle('warning', !!status.warning);
      label.textContent = status.label;
      detail.textContent = status.images ? '' : status.detail || '';
      detail.title = status.detail || '';
      detail.hidden = !!status.images;
      images.set(status);
      const ch = status.chapter;
      count.textContent = ch ? `${ch.index} / ${ch.total}` : '';
      symbol.style.setProperty('--fill', ch ? `${100 * ch.index / ch.total}%` : '0%');
      const failure = phase === 'retry' || phase === 'failed';
      if (failure) symbol.innerHTML = failureIcon;
      else if (phase === 'done') symbol.innerHTML = status.warning ? warningIcon : checkIcon;
      else symbol.innerHTML = downloadIcon;
      again.hidden = !failure && phase !== 'cancelled';
      again.textContent = phase === 'retry' ? '重试本章' : '重新下载';
      close.title = close.ariaLabel = phase === 'running' || phase === 'retry' ? '取消下载' : '关闭提示';
      updateAutoClose();
    }
    function reset() {
      controller?.abort();
      controller = undefined;
      resume = undefined;
      show('idle', { label: '' });
    }
    function syncPage() {
      const match = location.pathname.match(/^\/web\/reader\/([^/]+)/);
      const book = match?.[1]?.split('k')[0] || '';
      if (currentBook !== book) {
        historyController?.abort();
        historyController = undefined;
        historyVersion++;
        currentBook = book;
        downloaded = undefined;
        reset();
        if (book) void loadHistory(book);
      }
      if (book && !host.isConnected) document.body.append(host);
      if (!book) host.remove();
    }
    async function run() {
      if (controller) return;
      const job = new AbortController();
      controller = job;
      try {
        const result = await downloadBook(location.href, job.signal, {
          update(status) { if (controller === job) show('running', status); },
          retry(message) {
            job.signal.throwIfAborted();
            show('retry', { label: '章节读取失败', detail: message });
            return new Promise<void>((resolve, reject) => {
              const stop = () => reject(job.signal.reason);
              job.signal.addEventListener('abort', stop, { once: true });
              resume = () => {
                job.signal.removeEventListener('abort', stop);
                resume = undefined;
                resolve();
              };
            });
          },
        });
        if (controller === job) {
          historyVersion++;
          downloaded = true;
          updateStart();
          show('done', result);
        }
      } catch (err) {
        if (controller === job) {
          if (job.signal.aborted) show('cancelled', { label: '已取消' });
          else show('failed', { label: '下载失败', detail: err instanceof Error ? err.message : '下载请求失败' });
        }
      } finally {
        if (controller === job) { controller = undefined; resume = undefined; }
      }
    }
    start.onclick = run;
    again.onclick = () => { if (resume) resume(); else void run(); };
    close.onclick = () => { if (controller) controller.abort(); else { reset(); start.focus(); } };
    ctx.addEventListener(host, 'mouseenter', updateAutoClose);
    ctx.addEventListener(host, 'mouseleave', updateAutoClose);
    ctx.addEventListener(root, 'focusin', updateAutoClose);
    ctx.addEventListener(root, 'focusout', () => { ctx.setTimeout(updateAutoClose, 0); });
    ctx.addEventListener(document, 'visibilitychange', updateAutoClose);
    ctx.addEventListener(window, 'focus', updateAutoClose);
    ctx.addEventListener(window, 'blur', updateAutoClose);
    syncPage();
    ctx.setInterval(syncPage, 450);
    ctx.onInvalidated(() => {
      historyController?.abort();
      historyVersion++;
      chrome.storage.onChanged.removeListener(storageChanged);
      reset();
      host.remove();
    });
  },
});
