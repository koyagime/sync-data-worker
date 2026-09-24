/**
 * プレイヤーランクの「読み切ったか」の判断だけを置く場所。
 * ⚠ ここは **通信も playwright も持たない**。テストから素で読めるようにするため。
 */

const PAGES_PER_RUN = 120;      /* 1回の実行で読むページ数の上限（master は全243ページ） */
const RANKING_PAGE_SIZE = 20;   /* 公式の1ページあたり人数 */

/**
 * このサイクルを「読み切った」と認めてよいか。
 *
 * 🚨 認めると受け口(api_sync.php)が `is_end` を受けて、
 *    今回の一覧に居なかった人を**まとめてランキング外**にする。
 *    だから「本当に最後まで読めた時」だけ true。
 *
 * ⚠ 単位は **ページ数**。公式の `count` は人数ではなくページ数
 *    （2026-09-24 実測: master 243 / senior 42 / junior 29 = 公式ページの「◯ページ中」と一致）。
 *
 * @param {boolean} reachedEnd  ループが「終わり」と判断したか
 * @param {number}  pagesInCycle このサイクルでこれまでに読んだページ数
 * @param {number|null} totalPages 公式が言うページ数（判らなければ null）
 */
function rankCycleVerdict(reachedEnd, pagesInCycle, totalPages) {
  if (!reachedEnd) return { trustEnd: false, reason: 'まだ途中' };
  if (!(pagesInCycle > 0)) return { trustEnd: false, reason: '1ページも読めていない' };
  if (totalPages && pagesInCycle < totalPages) {
    return { trustEnd: false, reason: `公式は ${totalPages} ページと言っているのに ${pagesInCycle} ページで途切れた` };
  }
  return { trustEnd: true, reason: '' };
}

module.exports = { rankCycleVerdict, PAGES_PER_RUN, RANKING_PAGE_SIZE };
