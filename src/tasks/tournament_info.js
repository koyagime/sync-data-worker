const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser } = require('../browser');
const { getPool } = require('../db');
const { sendEventNotifications } = require('../discord');
const logger = require('../logger');

const STATE_FILE = path.join(__dirname, '../../state/tournament_info_state.json');
const RESUME_SILENT_AFTER_SECONDS = parseInt(process.env.RESUME_SILENT_AFTER_SECONDS || '7200', 10); // 2 hours
const INACTIVE_FETCH_INTERVAL = 28800; // 8 hours

const CATEGORIES = {
  city_league: {
    label: 'シティリーグ',
    event_attr_id: 3,
    event_type: 2,
    params: { 'event_type[]': '3:2', order: '1' },
    headerMessage: '🔔 シティリーグの募集が開始/空き枠が発生しました！',
    webhookEnv: 'DISCORD_CITY_WEBHOOK'
  },
  other_events: {
    label: 'その他大会',
    event_attr_id: 3,
    event_type: 7,
    params: { 'event_type[]': '3:7', order: '1' },
    headerMessage: '🔔 その他大会の募集が開始/空き枠が発生しました！',
    webhookEnv: 'DISCORD_OTHER_WEBHOOK'
  }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn('Failed reading state file:', e.message);
  }
  return {};
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    logger.error('Failed writing state file:', e.message);
  }
}

async function fetchCategoryEvents(catConfig, accepting) {
  let offset = 0;
  let allEvents = [];
  const queryStr = Object.entries(catConfig.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  while (true) {
    const url = `https://players.pokemon-card.com/event_search?${queryStr}&accepting=${accepting}&offset=${offset}`;
    const { status, data } = await fetchJsonInBrowser(url);

    if (status === 404 || !data || !data.event || data.event.length === 0) {
      break;
    }

    allEvents = allEvents.concat(data.event);
    offset += data.event.length;
  }

  return allEvents;
}

async function fetchPreviouslyActiveEvents(pool, event_attr_id, event_type) {
  const [rows] = await pool.query(
    `SELECT id, date_id, active_flag FROM tournament_info WHERE event_attr_id = ? AND event_type = ?`,
    [event_attr_id, event_type]
  );
  const activeMap = new Map();
  for (const row of rows) {
    const key = `${row.id}:${row.date_id}`;
    activeMap.set(key, Boolean(row.active_flag));
  }
  return activeMap;
}

function formatSqlDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (s.length === 8 && /^\d+$/.test(s)) {
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
  }
  return s;
}

async function saveEventsToDb(pool, events, isActive) {
  if (!events || events.length === 0) return;

  const sql = `
    INSERT INTO tournament_info (
      id, date_id, shop_id, event_date_params, event_date, event_date_week,
      event_started_at, event_ended_at, prefecture_name, deck_count, zip_code, address,
      venue, event_title, event_holding_id, event_type, csp_flg, event_league,
      regulation, entry_fee, capacity, shop_name, shop_term, league_name,
      event_attr_id, trainers_flg, discontinuance_flg, full_occupied_flg, cancel_flg,
      entry_restart_flg, recruit_flg, beginner_shop_flg, strong_shop_flg,
      champion_shop_flg, no_of_my_gym_reg, entry_status, entry_status_code, active_flag
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON DUPLICATE KEY UPDATE
      shop_id = VALUES(shop_id), event_date_params = VALUES(event_date_params),
      event_date = VALUES(event_date), event_date_week = VALUES(event_date_week),
      event_started_at = VALUES(event_started_at), event_ended_at = VALUES(event_ended_at),
      prefecture_name = VALUES(prefecture_name), deck_count = VALUES(deck_count),
      zip_code = VALUES(zip_code), address = VALUES(address), venue = VALUES(venue),
      event_title = VALUES(event_title), event_holding_id = VALUES(event_holding_id),
      event_type = VALUES(event_type), csp_flg = VALUES(csp_flg), event_league = VALUES(event_league),
      regulation = VALUES(regulation), entry_fee = VALUES(entry_fee), capacity = VALUES(capacity),
      shop_name = VALUES(shop_name), shop_term = VALUES(shop_term), league_name = VALUES(league_name),
      event_attr_id = VALUES(event_attr_id), trainers_flg = VALUES(trainers_flg),
      discontinuance_flg = VALUES(discontinuance_flg), full_occupied_flg = VALUES(full_occupied_flg),
      cancel_flg = VALUES(cancel_flg), entry_restart_flg = VALUES(entry_restart_flg),
      recruit_flg = VALUES(recruit_flg), beginner_shop_flg = VALUES(beginner_shop_flg),
      strong_shop_flg = VALUES(strong_shop_flg), champion_shop_flg = VALUES(champion_shop_flg),
      no_of_my_gym_reg = VALUES(no_of_my_gym_reg), entry_status = VALUES(entry_status),
      entry_status_code = VALUES(entry_status_code), active_flag = VALUES(active_flag),
      updated_at = CURRENT_TIMESTAMP
  `;

  for (const e of events) {
    const params = [
      e.id,
      e.date_id || null,
      e.shop_id || null,
      formatSqlDate(e.event_date_params),
      e.event_date || null,
      e.event_date_week || null,
      e.event_started_at || null,
      e.event_ended_at || null,
      e.prefecture_name || null,
      e.deck_count || null,
      e.zip_code || null,
      e.address || null,
      e.venue || null,
      e.event_title || null,
      e.event_holding_id || null,
      e.event_type || null,
      e.csp_flg || null,
      e.event_league || null,
      e.regulation || null,
      e.entry_fee || null,
      e.capacity || null,
      e.shop_name || null,
      e.shop_term || null,
      e.leagueName || null,
      e.event_attr_id || null,
      e.trainers_flg || null,
      e.discontinuance_flg || null,
      e.fullOccupiedFlg || null,
      e.cancelFlg || null,
      e.entryRestartFlg || null,
      e.recruitFlg || null,
      e.beginnerShopFlg || null,
      e.strongShopFlg || null,
      e.championShopFlg || null,
      e.noOfMyGymReg || null,
      e.entryStatus || null,
      e.entryStatusCode || null,
      isActive ? 1 : 0
    ];

    try {
      await pool.query(sql, params);
    } catch (err) {
      logger.error(`DB Save Error for event ${e.id}:${e.date_id}:`, err.message);
    }
  }
}

async function runTournamentInfoTask() {
  logger.info('--- Starting Tournament Info Task ---');
  const pool = getPool();
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    try {
      const catState = state[catKey] || {};
      const lastSuccess = catState.last_success || 0;
      const shouldStaySilent = (lastSuccess === 0) || ((nowSec - lastSuccess) > RESUME_SILENT_AFTER_SECONDS);

      if (shouldStaySilent) {
        logger.info(`Category [${cat.label}]: Silent recovery active (last success: ${lastSuccess ? new Date(lastSuccess * 1000).toLocaleString() : 'never'}). Notifications will be muted for this run.`);
      }

      // 1. Fetch accepting=true events
      logger.info(`Category [${cat.label}]: Fetching active events...`);
      const activeEvents = await fetchCategoryEvents(cat, 'true');
      logger.info(`Category [${cat.label}]: Fetched ${activeEvents.length} active events.`);

      // 2. Fetch inactive events if 8h elapsed
      const lastInactiveFetch = catState.last_inactive_fetch || 0;
      let inactiveEvents = [];
      if ((nowSec - lastInactiveFetch) >= INACTIVE_FETCH_INTERVAL) {
        logger.info(`Category [${cat.label}]: Fetching inactive events (8h elapsed)...`);
        inactiveEvents = await fetchCategoryEvents(cat, 'false');
        catState.last_inactive_fetch = nowSec;
        logger.info(`Category [${cat.label}]: Fetched ${inactiveEvents.length} inactive events.`);
      }

      // 3. Diff check against DB
      const dbActiveMap = await fetchPreviouslyActiveEvents(pool, cat.event_attr_id, cat.event_type);
      const newlyActive = [];

      for (const e of activeEvents) {
        const key = `${e.id}:${e.date_id}`;
        const wasActiveInDb = dbActiveMap.get(key);
        if (wasActiveInDb !== true) {
          newlyActive.push(e);
        }
      }

      // 4. Save to DB
      await saveEventsToDb(pool, activeEvents, true);
      if (inactiveEvents.length > 0) {
        await saveEventsToDb(pool, inactiveEvents, false);
      }

      // 5. Send Discord Notifications
      const webhookUrl = process.env[cat.webhookEnv];
      if (newlyActive.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: Muted ${newlyActive.length} notifications due to silent recovery mode.`);
        } else {
          logger.info(`Category [${cat.label}]: Found ${newlyActive.length} newly active/reopened events. Sending notifications...`);
          await sendEventNotifications(webhookUrl, cat.label, cat.headerMessage, newlyActive);
        }
      } else {
        logger.info(`Category [${cat.label}]: No new/reopened events detected.`);
      }

      // Update state
      catState.last_success = nowSec;
      state[catKey] = catState;
      saveState(state);

    } catch (err) {
      logger.error(`Error processing category [${cat.label}]:`, err.message);
    }
  }

  logger.info('--- Tournament Info Task Completed ---');
}

module.exports = { runTournamentInfoTask };
