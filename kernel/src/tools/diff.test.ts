import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from './diff.ts';

test('diff：新增文件（全 +）', () => {
  const d = lineDiff('', '第一行\n第二行');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
  assert.match(d.text, /\+ 第一行/);
});

test('diff：覆盖修改（+/− 混合）', () => {
  const d = lineDiff('alpha\nbeta\ngamma', 'alpha\nbeta2\ngamma\ndelta');
  assert.equal(d.added, 2); // beta2 + delta
  assert.equal(d.removed, 1); // beta
  assert.match(d.text, /\+ delta/);
  assert.match(d.text, /- beta\n/);
});

test('diff：删除文件（全 −）', () => {
  const d = lineDiff('a\nb\nc', '');
  assert.equal(d.removed, 3);
  assert.equal(d.added, 0);
});

test('diff：无变化', () => {
  const d = lineDiff('same', 'same');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.match(d.text, /无变化/);
});

test('diff：超大文件退化为计数', () => {
  const big = Array.from({ length: 1200 }, (_, i) => `line${i}`).join('\n');
  const d = lineDiff(big, big + '\nextra');
  assert.ok(d.text.includes('省略'));
});
