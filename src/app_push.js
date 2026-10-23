/**
 * ポケミミのアプリ（iPhone）へ、空き枠を知らせる。
 *
 * ■ 何をするか
 *   見つけた大会を pokemimi.com/api/push-notify.php に渡すだけ。
 *   **誰に送るかはポケミミ側が決める**（端末ごとの県はポケミミのDBにある）。ここは送り先を知らない。
 * ■ 二度鳴らさない
 *   ポケミミ側が (端末, 大会+理由) で記録している。同じ大会を2回渡しても2回は鳴らない。
 * ■ 鍵が無いとき
 *   PUSH_NOTIFY_KEY が無ければ**何もしない**（Discord の通知は今までどおり動く）。
 * ⚠ ここで失敗しても、取得と Discord を止めない。アプリの通知は「おまけの出口」。
 */
const axios = require('axios');
const logger = require('./logger');

const DEFAULT_URL = 'https://pokemimi.com/api/push-notify.php';
const BATCH = 50;

/** 'YYYYMMDD' でも 'YYYY-MM-DD' でも、ポケミミが読む 'YYYY-MM-DD' にそろえる */
function sqlDate(v) {
  const s = String(v ?? '').trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/** ポケミミが使う項目だけにする（送る量を減らす） */
function slim(e) {
  return {
    date_id: e.date_id,
    prefecture_name: e.prefecture_name || '',
    shop_name: e.shop_name || '',
    event_date_params: sqlDate(e.event_date_params),
  };
}

/**
 * @param {'city_new'|'city_freed'} kind
 * @param {Array} events
 * @param {{post?: Function, env?: object}} [deps] 試験で差し替える口
 * @returns {Promise<{skipped?: string, sent: number, targets: number}>}
 */
async function notifyApp(kind, events, deps = {}) {
  const env = deps.env || process.env;
  const key = String(env.PUSH_NOTIFY_KEY || '').trim();   /* ⚠ 合言葉の前後の改行・空白で 403 になっていた（2026-10-21〜23・Secrets に控えのファイルの改行ごと入った疑い） */
  if (!key) return { skipped: 'no_key', sent: 0, targets: 0 };
  const list = (events || []).filter((e) => e && e.date_id != null).map(slim);
  if (list.length === 0) return { sent: 0, targets: 0 };

  const post = deps.post || ((url, body) => axios.post(url, body, { timeout: 20000 }).then((r) => r.data));
  const url = env.PUSH_NOTIFY_URL || DEFAULT_URL;
  let sent = 0, targets = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    try {
      const r = await post(url, { key, kind, events: list.slice(i, i + BATCH) });
      sent += Number(r && r.sent) || 0;
      targets += Number(r && r.targets) || 0;
    } catch (err) {
      const code = err && err.response ? err.response.status : '';
      logger.warn(`アプリへの通知に失敗（${kind}・${code || err.message}）。Discord には影響しません`);
    }
  }
  logger.info(`アプリへの通知 ${kind}: 大会 ${list.length} 件 → 端末 ${sent} 通`);
  return { sent, targets };
}

/**
 * 大会結果が新しく入ったら、そのプレイヤーIDを登録したアプリに知らせる（2026-10-20）。
 * 誰に送るか・古い結果を鳴らさない判断はポケミミ側（push-notify.php の result）。
 * @param {Array<{player_id, event_holding_id, rank, point, tournament_day}>} rows
 */
async function notifyResults(rows, deps = {}) {
  const env = deps.env || process.env;
  const key = String(env.PUSH_NOTIFY_KEY || '').trim();   /* ⚠ 合言葉の前後の改行・空白で 403 になっていた（2026-10-21〜23・Secrets に控えのファイルの改行ごと入った疑い） */
  if (!key) return { skipped: 'no_key', sent: 0, targets: 0 };
  const list = (rows || []).filter((r) => r && r.player_id).map((r) => ({
    player_id: String(r.player_id), event_holding_id: r.event_holding_id,
    rank: Number(r.rank) || 0, point: Number(r.point) || 0, tournament_day: sqlDate(r.tournament_day),
  }));
  if (list.length === 0) return { sent: 0, targets: 0 };
  const post = deps.post || ((url, body) => axios.post(url, body, { timeout: 20000 }).then((r) => r.data));
  const url = env.PUSH_NOTIFY_URL || DEFAULT_URL;
  let sent = 0, targets = 0;
  for (let i = 0; i < list.length; i += 200) {
    try {
      const r = await post(url, { key, kind: 'result', events: list.slice(i, i + 200) });
      sent += Number(r && r.sent) || 0; targets += Number(r && r.targets) || 0;
    } catch (err) {
      const code = err && err.response ? err.response.status : '';
      logger.warn(`アプリへの結果通知に失敗（${code || err.message}）。取り込みには影響しません`);
    }
  }
  logger.info(`アプリへの結果通知: 新しい結果 ${list.length} 件 → 端末 ${sent} 通`);
  return { sent, targets };
}

module.exports = { notifyApp, notifyResults, sqlDate };
