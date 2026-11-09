import { strToU8, zipSync, type Zippable } from 'fflate';
import type { BookInfo } from './book';
import { request } from './messages';
import { resourceUrl } from './hosts';
import { coverImageSource, coverPageStyles, prepareCoverPage } from './cover';
import { rewriteDeclarations, rewriteStylesheet, safeSvgAttribute, sanitizeSvg, svgAttributes } from './epub-resources';

const xhtml = 'http://www.w3.org/1999/xhtml';
const xml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const html = (title: string, body: string, css = '') =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="${xhtml}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xml(title)}</title>${css}</head><body>${body}</body></html>`;
type Asset = { path: string; mime: string; bytes: Uint8Array };
export interface ImageIssue {
  kind?: 'image' | 'resource';
  location: string;
  name: string;
  source: string;
  reason: string;
  repaired: boolean;
  retry?: () => Promise<void>;
}

function reasonFor(error: unknown) {
  return error instanceof Error ? error.message : '图片请求失败';
}

function serialize(root: DocumentFragment) {
  const serializer = new XMLSerializer();
  return [...root.childNodes].map(node => serializer.serializeToString(node)).join('');
}

function convertFootnotes(root: DocumentFragment) {
  const markers = root.querySelectorAll('img.qqreader-footnote, span[data-wr-footernote]');
  if (!markers.length) return;
  const epubNamespace = 'http://www.idpf.org/2007/ops';
  let sequence = 0;
  let idNumber = 0;
  for (const marker of markers) {
    const text = (marker.getAttribute('data-wr-footernote') ?? marker.getAttribute('alt'))?.trim();
    const sup = document.createElement('sup');
    if (marker.id) sup.id = marker.id;
    if (!text) {
      sup.textContent = '〔注〕';
      marker.replaceWith(sup);
      continue;
    }

    sequence++;
    // Chapter fragment IDs can already include IDs supplied by the publisher.
    do { idNumber++; } while (root.getElementById('wr-fn-' + idNumber) || root.getElementById('wr-ref-' + idNumber));
    const ref = document.createElement('a');
    ref.id = 'wr-ref-' + idNumber;
    ref.setAttribute('href', '#wr-fn-' + idNumber);
    ref.setAttributeNS(epubNamespace, 'epub:type', 'noteref');
    ref.textContent = '[' + sequence + ']';
    sup.append(ref);
    const enclosingLink = marker.closest('a');
    if (enclosingLink) {
      enclosingLink.after(sup);
      marker.remove();
    } else marker.replaceWith(sup);

    const note = document.createElement('aside');
    note.id = 'wr-fn-' + idNumber;
    note.setAttributeNS(epubNamespace, 'epub:type', 'footnote');
    const back = document.createElement('a');
    back.setAttribute('href', '#' + ref.id);
    back.textContent = '返回正文';
    note.append('[' + sequence + '] ' + text + ' ', back);
    root.append(note);
  }
}

export class Epub {
  private assets = new Map<string, Asset>();
  private chapters: { title: string; content: string | DocumentFragment; css: () => string; svg: boolean }[] = [];
  private cover?: Asset;
  readonly issues: ImageIssue[] = [];
  missingStyles = 0;

  constructor(private readonly coverSource?: string) {}

  private async image(src: string, retry = false, signal?: AbortSignal): Promise<Asset> {
    signal?.throwIfAborted();
    src = coverImageSource(src, this.coverSource);
    if (!src.trim()) throw new Error('章节未提供图片地址');
    const url = new URL(src, location.href);
    if (url.protocol === 'http:') url.protocol = 'https:';
    const cached = this.assets.get(url.href);
    if (cached) return cached;
    const inline = url.href.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([a-z\d+/=]+)$/i);
    if (url.protocol === 'data:' && !inline) throw new Error('不支持此内嵌图片的格式或编码');
    if (!inline) resourceUrl(url.href);
    const { mime, data } = inline
      ? { mime: inline[1], data: inline[2] }
      : await request({ kind: 'asset', url: url.href, retry }, signal);
    signal?.throwIfAborted();
    if (!mime || !data) throw new Error('插图为空');
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const path = 'images/' + (this.assets.size + 1) + '.' + mime.split('/')[1];
    const asset = { path, mime, bytes };
    this.assets.set(url.href, asset);
    return asset;
  }

  private issue(location: string, name: string, src: string, error: unknown, restore: (asset: Asset) => void): ImageIssue {
    try { src = coverImageSource(src, this.coverSource); }
    catch { /* Keep an honest missing-cover issue if metadata has no usable cover. */ }
    const issue: ImageIssue = {
      location, name, source: src.startsWith('data:') ? '章节内嵌图片' : src, reason: reasonFor(error), repaired: false,
      retry: async () => {
        try {
          restore(await this.image(src, true));
          issue.repaired = true;
        } catch (err) {
          issue.reason = reasonFor(err);
        }
      },
    };
    return issue;
  }

  async add(title: string, source: string, css: string, signal: AbortSignal) {
    // Template contents stay inert, including images and embedded documents.
    const template = document.createElement('template');
    template.innerHTML = source.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? source;
    const root = template.content;
    const issues: ImageIssue[] = [];
    const report = (name: string, source: string, reason: string) => {
      issues.push({ kind: 'resource', location: title, name, source, reason, repaired: false });
    };
    root.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style,source').forEach(el => el.remove());
    const coverPage = prepareCoverPage(root);
    sanitizeSvg(root, report);
    convertFootnotes(root);
    for (const el of root.querySelectorAll('*')) {
      const svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
      const svgImage = svg && el.localName === 'image';
      for (const attr of [...el.attributes]) {
        if (!['id','class','style','href','title','alt','src','width','height','colspan','rowspan','lang','dir','epub:type'].includes(attr.name) &&
            !(svg && svgAttributes.has(attr.name.toLowerCase())))
          el.removeAttribute(attr.name);
        else if (svg && !['href','xlink:href','style'].includes(attr.name) && !safeSvgAttribute(attr.value)) {
          report('SVG 样式引用', attr.value, '外部 SVG 样式引用暂不支持导出');
          el.removeAttribute(attr.name);
        }
      }
      if (el.hasAttribute('style')) await rewriteDeclarations((el as HTMLElement | SVGElement).style, report);
      for (const attr of ['href', 'xlink:href']) {
        const href = el.getAttribute(attr);
        if (href != null && !href.startsWith('#') && !svgImage) {
          if (svg) report('SVG 引用', href, '外部 SVG 文档引用暂不支持导出');
          el.removeAttribute(attr);
        } else if (svg && attr === 'xlink:href' && href?.startsWith('#')) {
          el.setAttribute('href', href);
          el.removeAttribute('xlink:href');
        }
      }
      if (el.tagName !== 'IMG') el.removeAttribute('src');
    }
    for (const [index, img] of root.querySelectorAll('img').entries()) {
      signal.throwIfAborted();
      const src = img.getAttribute('src') || '';
      try {
        const asset = await this.image(src, false, signal);
        img.setAttribute('src', asset.path);
      } catch (error) {
        signal.throwIfAborted();
        const placeholder = document.createTextNode(img.alt || '［插图缺失］');
        img.replaceWith(placeholder);
        const name = '第 ' + (index + 1) + ' 张图' + (img.alt ? ' · ' + img.alt : '');
        issues.push(this.issue(title, name, src, error, asset => {
          img.setAttribute('src', asset.path);
          placeholder.replaceWith(img);
        }));
      }
    }
    for (const [index, image] of root.querySelectorAll('svg image').entries()) {
      const src = image.getAttribute('href') || image.getAttribute('xlink:href') || '';
      image.removeAttribute('xlink:href');
      if (src.startsWith('#')) { image.setAttribute('href', src); continue; }
      try {
        const asset = await this.image(src, false, signal);
        image.setAttribute('href', asset.path);
      } catch (error) {
        signal.throwIfAborted();
        const placeholder = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        placeholder.textContent = '［插图缺失］';
        image.replaceWith(placeholder);
        issues.push(this.issue(title, 'SVG 内第 ' + (index + 1) + ' 张图', src, error, asset => {
          image.setAttribute('href', asset.path);
          placeholder.replaceWith(image);
        }));
      }
    }
    const readCss = coverPage ? () => coverPageStyles : await rewriteStylesheet(css, report);
    signal.throwIfAborted();
    if (source.trim() && !root.textContent?.trim() && !root.querySelector('img,svg,hr')) {
      throw new Error('未识别到可保存的章节正文');
    }
    this.chapters.push({ title, content: issues.length ? root : serialize(root), css: readCss, svg: !!root.querySelector('svg') });
    this.issues.push(...issues);
  }

  async loadCover(book: BookInfo, signal: AbortSignal) {
    if (!book.cover) return;
    try {
      this.cover = await this.image(book.cover, false, signal);
    } catch (error) {
      signal.throwIfAborted();
      this.issues.push(this.issue('封面', book.title, book.cover, error, asset => { this.cover = asset; }));
    }
  }

  build(book: BookInfo, signal: AbortSignal): Uint8Array {
    signal.throwIfAborted();
    const files: Zippable = {
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    };
    const manifest: string[] = ['<item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
    const spine: string[] = [];
    const links: string[] = [];
    const styles = new Map<string,string>();
    this.chapters.forEach((ch, index) => {
      const id = 'ch' + (index + 1);
      const css = ch.css();
      let style = styles.get(css);
      if (css && !style) {
        style = 'style' + (styles.size + 1);
        styles.set(css, style);
        files['EPUB/' + style + '.css'] = strToU8(css);
        manifest.push(`<item id="${style}" href="${style}.css" media-type="text/css"/>`);
      }
      const sheet = style ? `<link rel="stylesheet" href="${style}.css"/>` : '';
      const content = typeof ch.content === 'string' ? ch.content : serialize(ch.content);
      files['EPUB/' + id + '.xhtml'] = strToU8(html(ch.title, content, sheet));
      manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"${ch.svg ? ' properties="svg"' : ''}/>`);
      spine.push(`<itemref idref="${id}"/>`);
      links.push(`<li><a href="${id}.xhtml">${xml(ch.title)}</a></li>`);
    });
    for (const [index, asset] of [...this.assets.values()].entries()) {
      files['EPUB/' + asset.path] = [asset.bytes, { level: 0 }];
      const properties = asset === this.cover ? ' properties="cover-image"' : '';
      manifest.push(`<item id="img${index}" href="${asset.path}" media-type="${asset.mime}"${properties}/>`);
    }
    files['EPUB/nav.xhtml'] = strToU8(html('目录', '<nav epub:type="toc"><h1>目录</h1><ol>' + links.join('') + '</ol></nav>'));
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    files['EPUB/book.opf'] = strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">weread:${xml(String(book.bookId))}</dc:identifier><dc:title>${xml(book.title)}</dc:title><dc:creator>${xml(book.author || '')}</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
    signal.throwIfAborted();
    // Worker-based fflate compression uses blob scripts, which MV3 disallows.
    return zipSync(files, { level: 5 });
  }
}
