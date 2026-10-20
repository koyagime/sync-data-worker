/**
 * アプリへの通知の渡し方を確かめる（通信は偽物）。
 *
 * 固定すること:
 *   ① 鍵が無ければ1通も投げない（Discord だけの今の動きを壊さない）
 *   ② 日付は 'YYYY-MM-DD' にそろえて渡す（ポケミミは 'YYYYMMDD' を読めない）
 *   ③ 送り先が落ちても例外を投げない（取得と Discord を止めない）
 *   ④ 50件ずつに分けて渡す
 *
 * 使い方: node test/app_push.test.js
 */
const path = require('path');
const assert = require('assert');
/* ⚠ 試験の出力を本番のログに混ぜない */
require.cache[require.resolve(path.join(__dirname, '../src/logger'))] = {
  exports: { info() {}, warn() {}, error() {} },
};
const { notifyApp } = require('../src/app_push');

(async () => {
  const ev = (i) => ({ date_id: i, prefecture_name: '東京都', shop_name: `店${i}`, event_date_params: '20261103', extra: 'x' });

  /* ① 鍵なし */
  let calls = 0;
  let r = await notifyApp('city_new', [ev(1)], { env: {}, post: async () => { calls++; return {}; } });
  assert.strictEqual(calls, 0, '鍵が無いのに投げた');
  assert.strictEqual(r.skipped, 'no_key');
  console.log('✅ 鍵が無ければ投げない');

  /* ② 形 */
  const bodies = [];
  r = await notifyApp('city_freed', [ev(1)], {
    env: { PUSH_NOTIFY_KEY: 'k' },
    post: async (url, b) => { bodies.push({ url, b }); return { sent: 2, targets: 2 }; },
  });
  assert.strictEqual(bodies[0].url, 'https://pokemimi.com/api/push-notify.php');
  assert.strictEqual(bodies[0].b.kind, 'city_freed');
  assert.strictEqual(bodies[0].b.events[0].event_date_params, '2026-11-03', '日付がそろっていない');
  assert.strictEqual(bodies[0].b.events[0].extra, undefined, '要らない項目まで送っている');
  assert.strictEqual(r.sent, 2);
  console.log('✅ 日付を YYYY-MM-DD にそろえ、要る項目だけ渡す');

  /* ③ 落ちても投げない */
  r = await notifyApp('city_new', [ev(1)], {
    env: { PUSH_NOTIFY_KEY: 'k' },
    post: async () => { const e = new Error('down'); e.response = { status: 503 }; throw e; },
  });
  assert.strictEqual(r.sent, 0);
  console.log('✅ 送り先が落ちても止まらない');

  /* ④ 分割 */
  let n = 0;
  await notifyApp('city_new', Array.from({ length: 120 }, (_, i) => ev(i)), {
    env: { PUSH_NOTIFY_KEY: 'k' }, post: async (u, b) => { n++; assert.ok(b.events.length <= 50); return {}; },
  });
  assert.strictEqual(n, 3, `120件が ${n} 回に分かれた（3回のはず）`);
  console.log('✅ 50件ずつに分ける');

  /* date_id が無い行は渡さない（ポケミミ側で捨てられるだけで、数が合わなくなる） */
  const got = [];
  await notifyApp('city_new', [{ prefecture_name: '東京都' }, ev(9)], {
    env: { PUSH_NOTIFY_KEY: 'k' }, post: async (u, b) => { got.push(...b.events); return {}; },
  });
  assert.strictEqual(got.length, 1);
  console.log('✅ date_id の無い行は渡さない');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
