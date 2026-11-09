import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverImageSource, isCoverPlaceholder } from '../lib/cover';

test('封面占位路径映射到书籍真实封面，保留封面地址参数', () => {
  const cover = 'https://res.weread.qq.com/cover/book.jpg?size=large';
  for (const source of ['../Images/device_phone_frontcover.jpg', '/web/Images/device_phone_frontcover.jpg',
    'https://weread.qq.com/web/Images/device_phone_frontcover.jpg']) {
    assert.equal(coverImageSource(source, cover), cover);
  }
});

test('普通图片和其他域名的同名图片保持原地址', () => {
  for (const source of ['https://res.weread.qq.com/Images/device_phone_frontcover.jpg',
    'https://example.com/Images/device_phone_frontcover.jpg', '../Images/illustration.jpg']) {
    assert.equal(isCoverPlaceholder(source), false);
    assert.equal(coverImageSource(source, 'https://res.weread.qq.com/cover.jpg'), source);
  }
});

test('没有可用真实封面时明确报错，不把占位图误当成功或循环替换', () => {
  const placeholder = '../Images/device_phone_frontcover.jpg';
  assert.throws(() => coverImageSource(placeholder), /未提供可用的封面/);
  assert.throws(() => coverImageSource(placeholder, ' '), /未提供可用的封面/);
  assert.throws(() => coverImageSource(placeholder, placeholder), /未提供可用的封面/);
});
