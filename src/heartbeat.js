/**
 * 「生きている印」をポケミミへ送る（2026-11-23）。
 *
 * ■ 何をするか
 *   各仕事（info / result / rank）の終わりに「公式を読めたか・読めた総数」を
 *   pokemimi.com/api/ingest-heartbeat.php に渡す。管理画面の「今日の確認」はこの印の新しさで
 *   「止まっている」を判定し、止まったら運営のアプリに知らせる（ポケミミ側の仕事）。
 * ■ なぜ要るか
 *   以前の判定は大会の表の更新時刻だけだった。大会に変化が無いと止まって見え、
 *   逆に公式に入れずに0件でも「成功」で終わっていた（2026-11-21〜）。
 * ■ 合言葉
 *   アプリへの通知と同じ PUSH_NOTIFY_KEY（Secrets に登録済み）。無ければ**送らない**（取り込みは止めない）。
 * ⚠ ここで失敗しても取り込みを止めない（印が届かなければ、ポケミミ側で「古い」と判る）。
 */
const logger = require('./logger');
const { why, postJson } = require('./app_push');

const DEFAULT_URL = 'https://pokemimi.com/api/ingest-heartbeat.php';
const TASKS = ['info', 'result', 'rank'];

/**
 * @param {'info'|'result'|'rank'} task
 * @param {{ok:boolean, total?:number|null, detail?:string, title?:string}} body
 * @param {{post?: Function, env?: object}} [deps] 試験で差し替える口
 * @returns {Promise<{sent:boolean, skipped?:string}>}
 */
async function sendHeartbeat(task, body, deps = {}) {
  const env = deps.env || process.env;
  const key = String(env.PUSH_NOTIFY_KEY || '').trim();
  if (!key) return { sent: false, skipped: 'no_key' };
  if (!TASKS.includes(task)) return { sent: false, skipped: 'unknown_task' };
  const url = env.HEARTBEAT_URL || DEFAULT_URL;
  const post = deps.post || ((u, b) => postJson(u, b, 15000));   /* curl で送る（app_push.js の注意書き） */
  const payload = {
    key,
    task,
    ok: !!body.ok,
    total: (typeof body.total === 'number' && Number.isFinite(body.total)) ? body.total : null,
    detail: String(body.detail || '').slice(0, 300),
    title: String(body.title || '').slice(0, 100)
  };
  try {
    await post(url, payload);
    return { sent: true };
  } catch (err) {
    logger.warn(`生きている印を送れませんでした（${task}・${why(err)}）。取り込みには影響しません`);
    return { sent: false, skipped: 'post_failed' };
  }
}

/**
 * 仕事の結果（読めたか）を、連続失敗の数取り器と生きている印に渡す。
 * @param {string} task
 * @param {{readOk:boolean, total?:number|null, reason?:string, detail?:string, title?:string}} res
 * @param {{onOk:Function, onFail:Function, send?:Function}} hooks
 *   onOk(task) / onFail(task, reason) は index.js の数取り器。onFail が true を返したら「落とす」（終了コード 1）
 * @returns {Promise<{fail:boolean}>}
 */
async function settleRead(task, res, hooks) {
  const send = hooks.send || sendHeartbeat;
  if (res && res.readOk) {
    hooks.onOk(task);
    await send(task, { ok: true, total: res.total, detail: res.detail || res.reason || '', title: res.title });
    return { fail: false };
  }
  const reason = (res && res.reason) || '公式を読めなかった（理由不明）';
  logger.warn(`公式を読めませんでした（${task}）: ${reason}`);
  console.log(`::warning::公式を読めませんでした（${task}）: ${reason}`);
  const fail = !!hooks.onFail(task, reason);
  await send(task, { ok: false, total: res ? res.total : null, detail: reason, title: res && res.title });
  return { fail };
}

module.exports = { sendHeartbeat, settleRead, DEFAULT_URL };
