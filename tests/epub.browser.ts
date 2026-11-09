import { Epub } from '../lib/epub';
import { unzipSync, strFromU8 } from 'fflate';
import type { Request } from '../lib/messages';

/** Bundle this module into a local Chromium harness; CSSOM and XMLSerializer must be native. */
export async function runEpubBrowserTests() {
  const checks: string[] = [];
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(label);
    checks.push(label);
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls: string[] = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
    sendMessage: async (message: Request) => {
      if (message.kind !== 'asset') throw new Error('Unexpected message: ' + message.kind);
      calls.push(message.url);
      if (message.url.endsWith('/repair.png') && !message.retry) return { error: '模拟图片请求失败' };
      return { mime: 'image/png', data: png };
    },
  } } });
  try {
    const shared = 'https://res.weread.qq.com/shared.png';
    const repair = 'https://res.weread.qq.com/repair.png';
    const epub = new Epub();
    const signal = new AbortController().signal;
    await epub.add('第一章', `<p>正文<img class="qqreader-footnote" alt="脚注内容" /></p>
      <img src="${shared}" alt="共享插图" />
      <img src="${repair}" alt="需要补回的正文插图" />
      <div class="repair" style="background-image:url('${shared}')"></div>
      <svg viewBox="0 0 10 10" onload="throw Error('must not execute')">
        <defs><linearGradient id="paint"><stop offset="0" stop-color="red" /></linearGradient><path id="shape" d="M0 0L10 10" /></defs>
        <path d="M0 0L10 10" fill="url(#paint)" stroke="red" />
        <use xlink:href="#shape" />
        <image xlink:href="#shape" />
        <image href="${shared}" width="10" height="10" />
        <use href="https://res.weread.qq.com/remote.svg#shape" />
        <foreignObject><div>不支持的外部内容</div></foreignObject>
        <script>throw Error('must not execute')</script>
      </svg>`, `@import url("https://res.weread.qq.com/external.css");
      @font-face { font-family: Embedded; src:url("https://res.weread.qq.com/font.woff2"); }
      .background {background-image:u\\72l("${shared}")}
      .repair {background-image:url("${repair}")}
      @media (min-width: 1px) {.nested {background-image:url("${shared}")}}
      .quoted::after {content:"url(https://example.com/plain-text) @import example;"}`, signal);
    await epub.add('第二章', `<p>第二章<img src="${shared}" /></p>`, '', signal);
    const book = { bookId: 'browser-fixture', title: '资源检查', author: '测试' };
    const unpack = () => unzipSync(epub.build(book, signal));
    const files = unpack();
    const source = strFromU8(files['EPUB/ch1.xhtml']!);
    const xml = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    check(!xml.querySelector('parsererror'), '章节 XHTML 为有效 XML');
    const svg = xml.querySelector('svg');
    check(svg?.getAttribute('viewBox') === '0 0 10 10', '保留 SVG viewBox');
    check(svg?.querySelector('path[fill]')?.getAttribute('d') === 'M0 0L10 10', '保留 SVG 路径与绘制属性');
    check(svg?.querySelector('path[fill]')?.getAttribute('fill') === 'url(#paint)', '保留本地 SVG 画笔引用');
    check(svg?.querySelector('use')?.getAttribute('href') === '#shape', '保留并规范化 SVG xlink 本地引用');
    check(svg?.querySelector('image')?.getAttribute('href') === '#shape', '保留 SVG image 的本地引用');
    check(!svg?.hasAttribute('onload') && !xml.querySelector('script, foreignObject'), '移除 SVG 活动内容');
    check(!source.includes('remote.svg'), '移除外部 SVG 文档引用');
    check(source.includes('epub:type="footnote"') && source.includes('脚注内容') && source.includes('href="#wr-fn-1"'), '脚注正文与来回链接保留');
    const opf = strFromU8(files['EPUB/book.opf']!);
    check(/href="ch1.xhtml"[^>]*properties="svg"/.test(opf), 'manifest 声明内嵌 SVG');
    check(opf.includes('idref="ch1"') && opf.includes('idref="ch2"') && opf.indexOf('idref="ch1"') < opf.indexOf('idref="ch2"'), 'spine 保留章节顺序');
    check(calls.filter(url => url === shared).length === 1, '正文图片与 SVG 在多章中共享缓存');
    const styleName = Object.keys(files).find(name => name.endsWith('.css'))!;
    const before = strFromU8(files[styleName]!);
    check(!before.includes('shared.png') && !before.includes('repair.png') && before.includes('background-image: none'),
      'CSS 背景图主动移除，保留正常排版样式');
    check(before.includes('plain-text') && !calls.some(url => url.includes('plain-text')), '引号中的 url 文字不作为资源下载');
    check(!/^\s*@(import\b|font-face\s*\{)/mi.test(before), '不支持的字体和样式导入安全移除');
    check(epub.issues.filter(issue => issue.kind === 'resource').length === 4, '字体、导入、不支持 SVG 与外部引用均进入资源提示');
    check(epub.issues.filter(issue => issue.kind === 'resource').every(issue => !issue.retry), '不支持的资源不会显示无效重试操作');
    const missing = epub.issues.find(issue => issue.source === repair);
    check(!!missing?.retry && !missing.repaired && calls.filter(url => url === repair).length === 1,
      '真实正文图片失败仍提示且可单独重试');
    await missing!.retry!();
    const repaired = unpack();
    const after = strFromU8(repaired['EPUB/ch1.xhtml']!);
    check(missing!.repaired && after.includes('src="images/2.png"'), '补回的正文图片反映在重新构建的章节中');
    check(!!repaired['EPUB/images/2.png'] && strFromU8(repaired['EPUB/book.opf']!).includes('href="images/2.png"'), '修复图片字节与 manifest 同时入包');

    const decorationOnly = new Epub();
    const callsBeforeDecoration = calls.length;
    const decorationCss = `.copyright-basemap {background-image:url('../Images/bq.jpg');background-size:cover}
      .bgimg-1 {background-image:url('../Images/bq.jpg')}
      .responsive {background-image:image-set("https://res.weread.qq.com/set-decoration.png" 1x)}`;
    for (let index = 0; index < 33; index++) {
      await decorationOnly.add('章节 ' + index,
        '<p class="bgimg-1" style="background-image:url(../Images/bq.jpg);color:rgb(1,2,3)">需要保留的正文</p>',
        decorationCss, signal);
    }
    check(calls.length === callsBeforeDecoration, '33 章重复的 CSS 背景引用完全不发出下载请求');
    check(decorationOnly.issues.length === 0, '同一背景图不再产生 66 条缺图误报');
    const decorationFiles = unzipSync(decorationOnly.build(book, signal));
    const decorationChapter = strFromU8(decorationFiles['EPUB/ch1.xhtml']!);
    check(decorationChapter.includes('需要保留的正文') && decorationChapter.includes('rgb(1, 2, 3)') &&
      !decorationChapter.includes('bq.jpg'), '忽略行内背景图片，同时保留正文及其他文字样式');
    const decorationStyles = Object.entries(decorationFiles).filter(([name]) => name.endsWith('.css'))
      .map(([, bytes]) => strFromU8(bytes)).join('\n');
    check(!decorationStyles.includes('set-decoration.png'), 'image-set 背景也不会残留外部图片地址');

    const coverUrl = 'https://res.weread.qq.com/book-cover.png';
    const coverBook = { bookId: 'cover-fixture', title: '封面检查', cover: coverUrl };
    const covered = new Epub(coverUrl);
    await covered.add('封面', '<h1 class="frontCover"><img src="../Images/device_phone_frontcover.jpg" alt="封面" /></h1>', '', signal);
    await covered.loadCover(coverBook, signal);
    const coverFiles = unzipSync(covered.build(coverBook, signal));
    const coverPage = new DOMParser().parseFromString(strFromU8(coverFiles['EPUB/ch1.xhtml']!), 'application/xhtml+xml');
    const coverManifest = strFromU8(coverFiles['EPUB/book.opf']!);
    const coverPath = coverPage.querySelector('img')?.getAttribute('src');
    check(!coverPage.querySelector('parsererror') && !!coverPath && !!coverFiles['EPUB/' + coverPath], '封面章节使用真实封面图片且图片已入包');
    check(coverManifest.includes(`href="${coverPath}" media-type="image/png" properties="cover-image"`), '封面章节与 EPUB 封面元数据引用同一图片');
    check(calls.filter(url => url === coverUrl).length === 1 && !calls.some(url => url.includes('device_phone_frontcover')), '占位封面不发出 404 请求，真实封面只获取一次');
    check(covered.issues.length === 0, '成功替换封面后不误报缺图');
    const coverCssPath = coverPage.querySelector('link')?.getAttribute('href');
    check(!!coverCssPath && !!coverFiles['EPUB/' + coverCssPath], '封面有独立的页面适配样式');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:600px;height:900px;border:0';
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); });
    const layoutSource = strFromU8(coverFiles['EPUB/ch1.xhtml']!)
      .replace(/<link\b[^>]*\/>/, '<style>' + strFromU8(coverFiles['EPUB/' + coverCssPath]!) + '</style>')
      .replace(`src="${coverPath}"`, `src="data:image/png;base64,${png}"`);
    frame.srcdoc = layoutSource;
    document.body.append(frame);
    await loaded;
    const shownCover = frame.contentDocument!.querySelector('img')!;
    await shownCover.decode();
    const coverBounds = shownCover.getBoundingClientRect();
    check(coverBounds.width >= 599 && Math.abs(coverBounds.height - coverBounds.width) < 1,
      '小尺寸封面随页面放大并保持原始比例');
    check(Math.abs((coverBounds.left + coverBounds.right) / 2 - 300) < 1, '封面在页面中水平居中');
    frame.style.width = '320px';
    check(shownCover.getBoundingClientRect().width <= 320 && shownCover.getBoundingClientRect().width >= 319,
      '窄页面封面自动缩放且不横向溢出');
    frame.remove();
    const unavailable = new Epub();
    await unavailable.add('封面', '<h1><img src="../Images/device_phone_frontcover.jpg" alt="封面" /></h1>', '', signal);
    check(unavailable.issues.length === 1 && unavailable.issues[0]!.reason.includes('未提供可用的封面'), '未提供真实封面时仍保留明确缺图提示');
    const mixed = new Epub(coverUrl);
    await mixed.add('正文', '<p>需要保留的正文</p><img src="../Images/device_phone_frontcover.jpg" />', '', signal);
    check(strFromU8(unzipSync(mixed.build(coverBook, signal))['EPUB/ch1.xhtml']!).includes('需要保留的正文'),
      '封面占位图与正文混排时不替换整章内容');
    return checks;
  } finally {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
}

const result = { done: false, passed: 0, checks: [] as string[], error: undefined as string | undefined };
Object.assign(globalThis, { __epubResourceTest: result });
void runEpubBrowserTests().then(checks => {
  Object.assign(result, { done: true, passed: checks.length, checks });
}, error => {
  Object.assign(result, { done: true, error: error instanceof Error ? error.stack || error.message : String(error) });
});
