const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../logs/tcg_runner.log');
const LOG_MAX_BYTES = 20 * 1024 * 1024; // 20MB

function ensureLogDir() {
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function rotateLogIfNeeded() {
  ensureLogDir();
  if (fs.existsSync(LOG_FILE)) {
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size >= LOG_MAX_BYTES) {
        const oldFile = LOG_FILE + '.1';
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch (e) {
      console.error('Failed log rotation:', e.message);
    }
  }
}

function formatTime() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T');
}

function writeLog(level, message, ...args) {
  rotateLogIfNeeded();
  const time = formatTime();
  const extra = args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : '';
  const line = `[${time}] [${level.toUpperCase()}] ${message}${extra}\n`;

  console.log(line.trim());

  try {
    fs.appendFileSync(LOG_FILE, line, { encoding: 'utf8' });
  } catch (e) {
    console.error('Failed writing to log file:', e.message);
  }
}

module.exports = {
  info: (msg, ...args) => writeLog('info', msg, ...args),
  warn: (msg, ...args) => writeLog('warn', msg, ...args),
  error: (msg, ...args) => writeLog('error', msg, ...args),
  debug: (msg, ...args) => writeLog('debug', msg, ...args),
  LOG_FILE
};
