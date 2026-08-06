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

async function postApiSync(action, payload) {
  const syncUrl = process.env.API_SYNC_URL || 'https://tcg-shop.jp/database/t/api_sync.php';
  const apiKey = process.env.API_KEY || 'pokemimi_secret_api_key_2026_x89a';

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
    logger.error(`API Sync failed (${action}):`, err.message);
    throw err;
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
  closePool
};
