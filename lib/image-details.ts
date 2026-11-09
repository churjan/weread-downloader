import type { DownloadStatus } from './export';
import type { ImageIssue } from './epub';

function sourceLabel(source: string) {
  if (!source) return '未提供地址';
  if (source === '章节内嵌图片') return source;
  if (!/^(?:https?:|\/)/i.test(source)) return source;
  try {
    const url = new URL(source, location.href);
    return url.host + url.pathname;
  } catch { return source; }
}

export function imageDetails(root: ShadowRoot, saved: (status: DownloadStatus) => void) {
  const toggle = root.querySelector<HTMLButtonElement>('.inspect')!;
  const panel = document.createElement('section');
  panel.id = 'image-details';
  panel.hidden = true;
  panel.setAttribute('aria-label', '资源详情');
  panel.innerHTML = `<header><b>资源详情</b><button type="button" class="collapse">收起</button></header>
    <ul></ul><footer><span role="status"></span><button type="button" class="save">下载修复版 EPUB</button></footer>`;
  root.append(panel);
  const list = panel.querySelector('ul')!;
  const note = panel.querySelector('[role=status]')!;
  const save = panel.querySelector<HTMLButtonElement>('.save')!;
  const collapse = panel.querySelector<HTMLButtonElement>('.collapse')!;
  let session: DownloadStatus['images'];
  let savedCount = 0;
  let summary = '';
  let pending: ImageIssue | undefined;

  function updateActions() {
    if (!session) return;
    const repaired = session.issues.filter(issue => issue.repaired).length;
    const dirty = repaired > savedCount;
    toggle.textContent = dirty ? `已补回 ${repaired - savedCount} 处 · 待下载修复版` : summary;
    note.textContent = dirty ? `已补回 ${repaired - savedCount} 处，可下载新版文件` : '';
    save.disabled = !dirty || !!pending;
    list.querySelectorAll('button').forEach((button, index) => {
      const issue = session!.issues[index]!;
      button.disabled = !!pending || issue.repaired || !issue.retry;
      button.textContent = issue === pending ? '重试中…' : issue.repaired ? '已补回' : issue.retry ? '重试这张图' : '暂不支持';
    });
  }

  function populate() {
    const current = session;
    if (!current || list.childElementCount) return;
    for (const issue of current.issues) {
      const row = document.createElement('li');
      row.innerHTML = `<b></b><span class="image-name"></span><span class="source"></span>
        <div class="issue-actions"><span class="reason"></span><button type="button"></button></div>`;
      row.querySelector('b')!.textContent = issue.location;
      row.querySelector('.image-name')!.textContent = issue.name;
      row.querySelector('.source')!.textContent = sourceLabel(issue.source);
      const reason = row.querySelector('.reason')!;
      reason.textContent = issue.repaired ? '' : issue.reason;
      const button = row.querySelector('button')!;
      button.onclick = async () => {
        if (session !== current || pending || issue.repaired || !issue.retry) return;
        pending = issue;
        updateActions();
        await issue.retry();
        if (session !== current) return;
        pending = undefined;
        reason.textContent = issue.repaired ? '' : issue.reason;
        updateActions();
        if (!panel.hidden) (issue.repaired ? save : button).focus();
      };
      list.append(row);
    }
    updateActions();
  }

  function expand(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      populate();
      collapse.focus();
    } else toggle.focus();
  }

  toggle.onclick = () => expand(panel.hidden);
  collapse.onclick = () => expand(false);
  panel.onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); expand(false); }
  };
  save.onclick = () => {
    if (!session || pending || save.disabled) return;
    try { saved(session.save()); }
    catch (error) { note.textContent = error instanceof Error ? error.message : '生成修复版失败，请重试'; }
  };
  return {
    toggle,
    set(status: DownloadStatus) {
      if (!session && !status.images) return;
      session = status.images;
      pending = undefined;
      list.replaceChildren();
      panel.hidden = true;
      toggle.hidden = !session;
      toggle.setAttribute('aria-expanded', 'false');
      savedCount = session?.issues.filter(issue => issue.repaired).length ?? 0;
      summary = status.detail || '';
      toggle.textContent = summary;
      toggle.title = '查看资源详情';
    },
  };
}
