type Report = (name: string, source: string, reason: string) => void;
const imageProperties = new Set(['background', 'background-image', 'border-image', 'border-image-source',
  'list-style', 'list-style-image', 'content', 'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image']);
const urlPattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;

function referencesIn(value: string) {
  const references: { start: number; end: number; source: string; replacement: string }[] = [];
  let at = 0;
  while (at < value.length) {
    const char = value[at];
    if (char === '"' || char === "'") {
      at++;
      while (at < value.length) {
        if (value[at] === '\\') at += 2;
        else if (value[at++] === char) break;
      }
      continue;
    }
    if (value.slice(at, at + 4).toLowerCase() === 'url(' && !/[\w-]/.test(value[at - 1] || '')) {
      urlPattern.lastIndex = at;
      const match = urlPattern.exec(value);
      if (match?.index === at) {
        const end = at + match[0].length;
        references.push({ start: at, end, source: unescapeCss(match[1] ?? match[2] ?? match[3] ?? '').trim(), replacement: 'none' });
        at = end;
        continue;
      }
    }
    at++;
  }
  return references;
}

function unescapeCss(value: string) {
  return value.replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex: string, escaped: string) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : escaped);
}

function quotedEnd(text: string, start: number) {
  const quote = text[start];
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === '\\') at += 2;
    else if (text[at++] === quote) break;
  }
  return at;
}

function reportImports(css: string, report: Report) {
  let at = 0;
  while (at < css.length) {
    if (css.startsWith('/*', at)) {
      const end = css.indexOf('*/', at + 2);
      at = end < 0 ? css.length : end + 2;
    } else if (css[at] === '"' || css[at] === "'") {
      at = quotedEnd(css, at);
    } else if (css[at] === '@') {
      const keyword = css.slice(at + 1).match(/^((?:[-\w]|\\[\da-f]{1,6}\s?|\\[^\r\n])+)/)?.[1] || '';
      if (unescapeCss(keyword).toLowerCase() !== 'import') { at++; continue; }
      const start = at;
      at += 1 + keyword.length;
      while (at < css.length && css[at] !== ';' && css[at] !== '{') {
        if (css[at] === '"' || css[at] === "'") at = quotedEnd(css, at);
        else at++;
      }
      report('外部样式表', css.slice(start, at + 1).trim().slice(0, 500), '外部样式表暂不支持导出');
      at++;
    } else at++;
  }
}

/** Work on native CSSOM values so escaped URL functions and image-set strings are normalized first. */
export async function rewriteDeclarations(style: CSSStyleDeclaration, report: Report) {
  for (const name of Array.from(style)) {
    const value = style.getPropertyValue(name);
    const priority = style.getPropertyPriority(name);
    const references = referencesIn(value);
    if (!references.length) continue;
    const render = () => {
      let cursor = 0;
      let output = '';
      for (const reference of references) {
        output += value.slice(cursor, reference.start) + reference.replacement;
        cursor = reference.end;
      }
      return output + value.slice(cursor);
    };
    for (const reference of references) {
      if (reference.source.startsWith('#')) {
        reference.replacement = 'url(' + JSON.stringify(reference.source) + ')';
      } else if (!imageProperties.has(name.toLowerCase())) {
        report('样式资源', reference.source, '此类外部样式资源暂不支持导出');
      }
      // CSS decoration is deliberately excluded from downloads and missing-image counts.
    }
    style.setProperty(name, render(), priority);
    // Replacing URLs inside image-set()/cross-fade() may make the declaration invalid.
    // CSSOM then retains its old value; never leave those external references in the EPUB.
    if (referencesIn(style.getPropertyValue(name)).some(reference => !reference.source.startsWith('#'))) {
      style.setProperty(name, 'none', priority);
    }
  }
}

export async function rewriteStylesheet(css: string, report: Report): Promise<() => string> {
  if (!css.trim()) return () => '';
  // Constructable stylesheets never load @import. Report imports before the browser discards them.
  reportImports(css, report);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  async function visit(rule: CSSRule): Promise<(() => string) | undefined> {
    if (rule.type === CSSRule.FONT_FACE_RULE) {
      report('嵌入字体', (rule as CSSFontFaceRule).style.getPropertyValue('font-family') || '字体资源',
        '字体资源暂不支持导出，阅读器将使用替代字体');
      return;
    }
    if ('style' in rule) await rewriteDeclarations((rule as CSSStyleRule).style, report);
    if ('cssRules' in rule) {
      const children: (() => string)[] = [];
      for (const child of Array.from((rule as CSSGroupingRule).cssRules)) {
        const output = await visit(child);
        if (output) children.push(output);
      }
      const header = rule.cssText.slice(0, rule.cssText.indexOf('{') + 1);
      return () => header + '\n' + ('style' in rule ? (rule as CSSStyleRule).style.cssText + '\n' : '') +
        children.map(read => read()).join('\n') + '\n}';
    }
    return () => rule.cssText;
  }
  const rules: (() => string)[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    const output = await visit(rule);
    if (output) rules.push(output);
  }
  return () => rules.map(read => read()).join('\n');
}

const svgElements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'pattern', 'use', 'image', 'title', 'desc', 'symbol', 'marker', 'filter', 'fegaussianblur', 'feoffset',
  'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fefuncr', 'fefuncg', 'fefuncb', 'fefunca',
  'fecomposite', 'femerge', 'femergenode', 'feflood', 'feturbulence', 'fedisplacementmap', 'femorphology']);
export const svgAttributes = new Set(['viewbox', 'preserveaspectratio', 'd', 'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'opacity', 'transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'dx', 'dy', 'points', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'spreadmethod', 'patternunits', 'patterncontentunits', 'patterntransform',
  'clippathunits', 'maskunits', 'maskcontentunits', 'clip-path', 'mask', 'filter', 'marker-start',
  'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'baseline-shift',
  'textlength', 'lengthadjust', 'startoffset', 'xlink:href', 'color', 'display', 'visibility', 'vector-effect',
  'paint-order', 'in', 'in2', 'result', 'stddeviation', 'mode', 'type', 'values', 'operator', 'k1', 'k2',
  'k3', 'k4', 'flood-color', 'flood-opacity', 'basefrequency', 'numoctaves', 'seed', 'scale',
  'xchannelselector', 'ychannelselector', 'radius', 'xmlns', 'xmlns:xlink']);

export function sanitizeSvg(root: DocumentFragment, report: Report) {
  for (const element of root.querySelectorAll('svg *')) {
    if (!root.contains(element)) continue;
    if (!svgElements.has(element.localName.toLowerCase())) {
      report('SVG 内容', element.localName, '不支持的 SVG 内容已移除');
      element.remove();
    }
  }
}

/** SVG presentation attributes may refer to local paint servers, never remote documents. */
export function safeSvgAttribute(value: string): boolean {
  return referencesIn(unescapeCss(value)).every(reference => reference.source.startsWith('#'));
}
