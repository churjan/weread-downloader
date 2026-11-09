/** The reader replaces this EPUB-relative placeholder with bookInfo.cover at runtime. */
export function isCoverPlaceholder(source: string): boolean {
  try {
    const url = new URL(source, 'https://weread.qq.com/web/reader/');
    return url.hostname === 'weread.qq.com' && ['http:', 'https:'].includes(url.protocol) &&
      /\/Images\/device_phone_frontcover\.jpg$/i.test(url.pathname);
  } catch { return false; }
}

export function coverImageSource(source: string, cover?: string): string {
  if (!isCoverPlaceholder(source)) return source;
  if (!cover?.trim() || isCoverPlaceholder(cover)) throw new Error('书籍未提供可用的封面图片地址');
  return cover;
}

export const coverPageStyles = `html,body{margin:0;padding:0}
.weread-cover{margin:0;padding:0;text-align:center;text-indent:0}
.weread-cover img{display:block;width:100%;max-width:100%;height:auto;margin:0 auto}`;

/** Replace reader-only cover layout only when the chapter contains that image alone. */
export function prepareCoverPage(root: DocumentFragment): boolean {
  const images = root.querySelectorAll('img');
  const image = images[0];
  const text = root.textContent?.replace(/\s/g, '') || '';
  if (images.length !== 1 || !image || !isCoverPlaceholder(image.getAttribute('src') || '') ||
      (text !== '' && text !== '封面') || root.querySelector('svg,table,audio,video,hr')) return false;
  const wrapper = root.ownerDocument.createElement('div');
  wrapper.className = 'weread-cover';
  image.removeAttribute('width');
  image.removeAttribute('height');
  image.removeAttribute('style');
  wrapper.append(image);
  root.replaceChildren(wrapper);
  return true;
}
