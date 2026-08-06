const axios = require('axios');
const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;

function getPool() {
  if (!pool) {
    const config = {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+09:00',
      dateStrings: true
    };
    pool = mysql.createPool(config);
  }
  return pool;
}

/**
 * PHP の受け口へ送る。
 *
 * ⚠ 鍵とURLは **必ず環境変数から**。
 *   以前はここに `|| 'pokemimi_secret_api_key_2026_x89a'` と直書きしていた。
 *   このリポジトリは public なので、それは **書き込み用の鍵を全世界に公開している**のと同じ。
 *   Secrets には API_KEY / API_SYNC_URL が登録済みなので、フォールバックは不要。
 *   無ければ **黙って既定で動かず、その場で止める**（間違った鍵で走ると 403 が延々出るだけ）。
 */
async function postApiSync(action, payload) {
  const syncUrl = process.env.API_SYNC_URL;
  const apiKey = process.env.API_KEY;
  if (!syncUrl || !apiKey) {
    throw new Error('API_SYNC_URL / API_KEY が設定されていません（GitHub Actions の Secrets を確認）');
  }

  try {
    const res = await axios.post(syncUrl, { action, api_key: apiKey, ...payload }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      },
      timeout: 60000
    });

    if (res.data && res.data.status === 'ok') {
      return res.data;
    }
    throw new Error(`API Sync returned status error: ${JSON.stringify(res.data)}`);
  } catch (err) {
    /* ⚠ 受け口は失敗の理由を **本文に入れて返す**。
       以前は err.message しか出しておらず「500」としか判らなかったため、
       原因（列名 rank が MySQL8 の予約語で構文エラー）の特定が丸一日遅れた。
       本文を必ず出す。 */
    const body = err.response && err.response.data;
    const detail = body ? ` / 受け口の返事: ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}` : '';
    logger.error(`API Sync failed (${action}): ${err.message}${detail}`);
    throw err;
  }
}

/** 読むだけの口を叩く（未取得の一覧をもらう）。失敗しても本体を止めない。 */
async function fetchBacklog(action, params = {}) {
  try {
    const res = await postApiSync(action, params);
    return res || null;
  } catch (err) {
    logger.error(`Backlog fetch failed (${action}): ${err.message}`);
    return null;
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  postApiSync,
  fetchBacklog,
  closePool
};
