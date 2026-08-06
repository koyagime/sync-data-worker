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

    if (!config.user || !config.password || !config.database) {
      logger.warn('DB credentials not fully set in env. Please check .env file.');
    }

    pool = mysql.createPool(config);
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  closePool
};
