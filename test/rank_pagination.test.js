/**
 * プレイヤーランクの打ち切り判定と、ページ送りの計算を見る（通信なし）。
 *
 * 🚨 2026-09-24: 公式の `count` は **ページ数**なのに人数だと思って比べていたため、
 *    master は 13ページ=260人で "cycle completed" と記録され、
 *    約1年、4,860人中260人しか取り込めていなかった（ログ上は正常に見えていた）。
 *    もう一度同じ取り違えをしたら、ここで気づけるようにする。
 *
 * 使い方: node test/rank_pagination.test.js
 */
const assert = require('assert');
const { rankCycleVerdict, PAGES_PER_RUN, RANKING_PAGE_SIZE } = require('../src/rank_rules');

let ng = 0;
function check(label, fn) {
  try { fn(); console.log('✅ ' + label); }
  catch (e) { ng++; console.error('❌ ' + label + ' — ' + e.message); }
}

/* ── 読み切ったと認めてよい場合 ───────────────────────── */
check('公式が言うページ数まで読んだ', () =>
  assert.strictEqual(rankCycleVerdict(true, 243, 243).trustEnd, true));
check('ページ数が判らないが空ページに到達した', () =>
  assert.strictEqual(rankCycleVerdict(true, 29, null).trustEnd, true));
check('シーズン明けで本当に13ページだけ（正常な激減）', () =>
  assert.strictEqual(rankCycleVerdict(true, 13, 13).trustEnd, true));

/* ── 認めてはいけない場合（ここで認めると全員がランキング外になる） ── */
check('1ページも読めていない', () =>
  assert.strictEqual(rankCycleVerdict(true, 0, 243).trustEnd, false));
check('公式は243ページなのに13ページで途切れた（今回の事故そのもの）', () =>
  assert.strictEqual(rankCycleVerdict(true, 13, 243).trustEnd, false));
check('まだ途中', () =>
  assert.strictEqual(rankCycleVerdict(false, 120, 243).trustEnd, false));

/* ── 人数とページ数を取り違えていないか ─────────────────
   master: 243ページ × 20人 = 4,860人。人数で比べると 13ページ(260人) で止まる。 */
check('人数(4860)をページ数(243)と比べる取り違えを再現しない', () => {
  const peopleAfter13Pages = 13 * RANKING_PAGE_SIZE;   // 260
  assert.ok(peopleAfter13Pages >= 243, '前提: 人数で比べると13ページで条件が成立してしまう');
  assert.strictEqual(rankCycleVerdict(true, 13, 243).trustEnd, false,
    'ページ数で比べていれば 13/243 では読み切ったことにならない');
});

/* ── ページ送りの計算（offset から pageNo） ───────────── */
check('offset から pageNo が正しく出る', () => {
  const pageNoOf = (offset) => Math.floor(offset / RANKING_PAGE_SIZE) + 1;
  assert.strictEqual(pageNoOf(0), 1);
  assert.strictEqual(pageNoOf(20), 2);
  assert.strictEqual(pageNoOf(2400), 121);
});

/* ── 1周に何回かかるか（PAGES_PER_RUN を下げすぎ/上げすぎたら気づく） ── */
check('master 243ページが 1〜3回の実行で1周できる', () => {
  const runs = Math.ceil(243 / PAGES_PER_RUN);
  assert.ok(runs >= 1 && runs <= 3, `いまの PAGES_PER_RUN=${PAGES_PER_RUN} だと ${runs} 回かかる`);
});

if (ng) { console.error(`\n❌ ${ng} 件。取り込みが静かに切り捨てる形になっています。`); process.exit(1); }
console.log('\n✅ 打ち切りはページ数で判断し、読み切れていないのに終わりと言わない');
