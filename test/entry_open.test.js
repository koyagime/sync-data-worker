/* 受付前と受付中を分ける（2026-11-25 運営「先着受付前でも通知来る？募集中だけ通知って可能？」）
 *   公式の accepting=true の一覧には受付前の大会も入る。受付中だけを「受付開始」として送る。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* tournament_info.js は playwright を読むので、関数だけを文字から取り出して試す（形を写さない・本物の文を eval する） */
const src = fs.readFileSync(path.join(__dirname, '../src/tasks/tournament_info.js'), 'utf8');
const fnSrc = src.slice(src.indexOf('function isEntryOpen'), src.indexOf('}', src.indexOf('function isEntryOpen') + 120) + 1);
const isEntryOpen = new Function(fnSrc + '; return isEntryOpen;')();

test('受付中（満席でない）だけが受付開始', () => {
  assert.strictEqual(isEntryOpen({ entryStatus: '先着受付中' }), true);
  assert.strictEqual(isEntryOpen({ entryStatus: '抽選受付中' }), true);
  assert.strictEqual(isEntryOpen({ entry_status: '受付中' }), true);
});
test('不成立: 受付前・満席・受付終了は受付開始ではない', () => {
  assert.strictEqual(isEntryOpen({ entryStatus: '先着受付前' }), false);
  assert.strictEqual(isEntryOpen({ entryStatus: '抽選受付前' }), false);
  assert.strictEqual(isEntryOpen({ entryStatus: '受付中（満席）' }), false);
  assert.strictEqual(isEntryOpen({ entryStatus: '受付終了' }), false);
  assert.strictEqual(isEntryOpen({}), false);
});
test('送り分け: 新しく載った受付前は city_soon、受付中は city_new、受付前→受付中（opened）は city_new', () => {
  assert.ok(/await notifyApp\('city_soon', notYet\)/.test(src));
  assert.ok(/await notifyApp\('city_new', nowOpen\)/.test(src));
  assert.ok(/await notifyApp\('city_new', opened\)/.test(src));
  assert.ok(/if \(res && Array\.isArray\(res\.opened\)\) opened\.push/.test(src));
  /* 復帰直後は鳴らさない（今すでに受付中の大会に一斉に飛ばさない） */
  const block = src.slice(src.indexOf('if (opened.length > 0)'), src.indexOf('if (newlyActive.length > 0)'));
  assert.ok(/shouldStaySilent/.test(block));
});
