/**
 * プレイヤーランクの「読み切ったか」の判断だけを置く場所。
 * ⚠ ここは **通信も playwright も持たない**。テストから素で読めるようにするため。
 */

/* 1回の実行で読むページ数の上限（master は全243ページ）。
   2026-09-24 に 40→120（当時 master が260人しか入っておらず、早く埋めたかったため）。
   2026-09-28 に **60** へ。もう 5,926人 入っていて追いつく必要がない一方、
   公式への往復は減らしたい。60 なら 4〜5回＝およそ1日で1周する（順位が動くのは週末の大会後）。
   ⚠ ここは「速さ 対 公式への負荷」のつまみ。増やす前に info.yml の所要時間の90%点を見ること。 */
const PAGES_PER_RUN = 60;
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
