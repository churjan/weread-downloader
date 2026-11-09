import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteDeclarations, safeSvgAttribute } from '../lib/epub-resources';

/** Values here are the normalized strings supplied by browser CSSStyleDeclaration. */
function declarations(entries: [string, string, string?][]) {
  const values = new Map(entries.map(([name, value, priority]) => [name, { value, priority: priority || '' }]));
  return Object.assign(entries.map(([name]) => name), {
    getPropertyValue: (name: string) => values.get(name)?.value || '',
    getPropertyPriority: (name: string) => values.get(name)?.priority || '',
    setProperty: (name: string, value: string, priority = '') => values.set(name, { value, priority }),
  }) as unknown as CSSStyleDeclaration;
}

test('CSS 背景图片主动忽略，不产生缺图提示且保留其他背景样式', async () => {
  const style = declarations([['background-image', 'url("https://res.weread.qq.com/a.png"), url("https://res.weread.qq.com/b.png")', 'important']]);
  await rewriteDeclarations(style, () => assert.fail('Ignored backgrounds must not be reported as missing content'));
  assert.equal(style.getPropertyValue('background-image'), 'none, none');
  assert.equal(style.getPropertyPriority('background-image'), 'important');
});

test('本地 SVG 片段保留，外部滤镜引用删除并报告', async () => {
  const style = declarations([['fill', 'url("#paint")'], ['filter', 'url("https://res.weread.qq.com/filter.svg#blur")']]);
  const warnings: string[] = [];
  await rewriteDeclarations(style, (_name, source) => { warnings.push(source); });
  assert.equal(style.getPropertyValue('fill'), 'url("#paint")');
  assert.equal(style.getPropertyValue('filter'), 'none');
  assert.deepEqual(warnings, ['https://res.weread.qq.com/filter.svg#blur']);
});

test('正文里的 url 字样和引号内文字不是 CSS 图片资源', async () => {
  const style = declarations([['content', '"url(https://example.com/text)"'], ['font-family', '"url(example)"']]);
  await rewriteDeclarations(style, () => assert.fail('Quoted text is not an unsupported resource'));
  assert.equal(style.getPropertyValue('content'), '"url(https://example.com/text)"');
});

test('SVG 样式只允许本地引用，转义后的外部引用也被拒绝', () => {
  assert.equal(safeSvgAttribute('url(#paint)'), true);
  assert.equal(safeSvgAttribute('rgb(20 30 40)'), true);
  assert.equal(safeSvgAttribute('url("https://res.weread.qq.com/paint.svg#color")'), false);
  assert.equal(safeSvgAttribute('u\\72l(https://res.weread.qq.com/paint.svg)'), false);
});
