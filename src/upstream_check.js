/**
 * 公式（players.pokemon-card.com）を「本当に読めたか」を決める場所（2026-11-23）。
 * ⚠ ここは **通信も playwright も持たない**。テストから素で読めるようにするため。
 *
 * 🚨 なぜ要るか（2026-11-23 運営「いちばんの問題は公式の取得ができなくなって、何も動いていない！みたいな状況になること」）:
 *   11/21 10:42Z ごろから、最初の頁の題名が「しばらくお待ちください...」（Cloudflare の確かめの画面・日本語）。
 *   関門の判定は英語の題名しか知らず、確かめの画面のまま「session established」と書いて進んでいた。
 *   その後の記録は毎回「Fetched 0 active events」「受付中 0 / 受付終了 0 のまま」で **成功**。
 *   「本当に0件」と「公式に入れず0件」が同じ形をしていて、止まっても誰も気づけない。
 *
 * 実物（2026-11-23 本物のブラウザで公式を叩いて確かめた）:
 *   ・大会がある   → 200 {"code":200,"event":[…20件],"eventCount":696}
 *   ・大会が0件    → 404 {"code":404,"message":"イベント情報が存在しません。"}（JSON。HTML ではない）
 *   ・絞り込み無しで受付終了を含む総数（order=1&accepting=false）→ 200 eventCount=9515
 *     ＝全国の全大会。シーズンの切れ目でも0にはならない（ジムバトル等が常にある）
 *   → 「読めた」は **公式の JSON が期待の形で返った** ことで決める。0件の 404 も JSON なので区別できる。
 */

/* 確かめの画面の題名。⚠ 日本語の「しばらくお待ちください...」は 2026-11-21 から実際に出ている（locale ja-JP のため） */
const CF_INTERSTITIAL = /just a moment|attention required|checking your browser|cloudflare|しばらくお待ちください/i;

/** 公式の「該当0件」の返事か（404 でも本文が公式の JSON のときだけ） */
function isOfficialEmpty(res) {
  return !!res && res.status === 404 && !!res.data && typeof res.data === 'object' && Number(res.data.code) === 404;
}

/**
 * event_search の返事から総数を読む。
 * @returns {number|null} 総数。0件の正しい返事は 0。**読めなければ null**（0 と混ぜない）
 */
function readEventCount(res) {
  if (isOfficialEmpty(res)) return 0;
  if (!res || res.status !== 200 || !res.data || typeof res.data !== 'object') return null;
  if (typeof res.data.eventCount !== 'number' || !Array.isArray(res.data.event)) return null;
  return res.data.eventCount;
}

/**
 * 「公式の総数（受付終了を含む）」が読めたか。これを「公式に入れた」の証拠にする。
 * ⚠ 全国の全大会が0件は起こりえない。0 や 404 は「読めていない」とみなす
 *    （公式の作りが変わって何も返さなくなったときも、ここで止める）。
 * @returns {{ok:boolean, total:number|null, reason:string}}
 */
function readOfficialTotal(res) {
  const n = readEventCount(res);
  if (n === null) {
    const st = res && res.status;
    return { ok: false, total: null, reason: `公式の総数が数として読めなかった（HTTP ${st === undefined ? '?' : st}・返事の形が違う）` };
  }
  if (n <= 0) return { ok: false, total: 0, reason: '公式の総数（受付終了を含む全大会）が0件。ありえないので読めていないとみなす' };
  return { ok: true, total: n, reason: '' };
}

/**
 * 大会結果の一覧（フィード）の返事が読めたか。
 * @returns {{ok:boolean, events:Array, total:number|null, reason:string}}
 */
function readResultFeed(res) {
  if (isOfficialEmpty(res)) return { ok: true, events: [], total: 0, reason: '' };
  if (res && res.status === 200 && res.data && Array.isArray(res.data.event)) {
    const total = typeof res.data.eventCount === 'number' ? res.data.eventCount : res.data.event.length;
    return { ok: true, events: res.data.event, total, reason: '' };
  }
  return { ok: false, events: [], total: null, reason: `大会結果の一覧の返事の形が違う（HTTP ${res && res.status !== undefined ? res.status : '?'}）` };
}

/**
 * ランキングの1ページの返事を分ける。
 * @returns {'page'|'end'|'bad'} page=選手が入っている / end=終わり（404・空の配列）/ bad=形が違う（読めていない）
 */
function classifyRankPage(res) {
  if (!res) return 'bad';
  if (res.status === 404) return 'end';
  if (res.status !== 200 || !res.data || typeof res.data !== 'object' || !Array.isArray(res.data.result)) return 'bad';
  return res.data.result.length === 0 ? 'end' : 'page';
}

/** 「読めなかった」の印を付けた失敗（index.js の数取り器が「次の回で拾い直す」側として数える） */
function unreadableError(message) {
  const err = new Error(message);
  err.pmTransient = true;
  err.pmUpstream = true;
  err.pmUnreadable = true;
  return err;
}

module.exports = {
  CF_INTERSTITIAL,
  isOfficialEmpty,
  readEventCount,
  readOfficialTotal,
  readResultFeed,
  classifyRankPage,
  unreadableError
};
