const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser } = require('../browser');
const { postApiSync, getPool } = require('../db');
const { sendEventNotifications } = require('../discord');
const logger = require('../logger');

const STATE_FILE = path.join(__dirname, '../../state/tournament_info_state.json');
const RESUME_SILENT_AFTER_SECONDS = parseInt(process.env.RESUME_SILENT_AFTER_SECONDS || '7200', 10);
const INACTIVE_FETCH_INTERVAL = 28800;

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

function formatSqlDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (s.length === 8 && /^\d+$/.test(s)) {
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
  }
  return s;
}

async function saveEventsToDb(events, isActive) {
  if (!events || events.length === 0) return;

  const formattedEvents = events.map(e => ({
    ...e,
    event_date_params: formatSqlDate(e.event_date_params)
  }));

  const BATCH_SIZE = 100;
  for (let i = 0; i < formattedEvents.length; i += BATCH_SIZE) {
    const batch = formattedEvents.slice(i, i + BATCH_SIZE);
    logger.info(`Sending batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(formattedEvents.length / BATCH_SIZE)} (${batch.length} events)...`);
    await postApiSync('info', { events: batch, is_active: isActive });
  }
}

async function runTournamentInfoTask() {
  logger.info('--- Starting Tournament Info Task ---');
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    try {
      const catState = state[catKey] || {};
      const lastSuccess = catState.last_success || 0;
      const shouldStaySilent = (lastSuccess === 0) || ((nowSec - lastSuccess) > RESUME_SILENT_AFTER_SECONDS);

      if (shouldStaySilent) {
        logger.info(`Category [${cat.label}]: Silent recovery active.`);
      }

      logger.info(`Category [${cat.label}]: Fetching active events...`);
      const activeEvents = await fetchCategoryEvents(cat, 'true');
      logger.info(`Category [${cat.label}]: Fetched ${activeEvents.length} active events.`);

      const lastInactiveFetch = catState.last_inactive_fetch || 0;
      let inactiveEvents = [];
      if ((nowSec - lastInactiveFetch) >= INACTIVE_FETCH_INTERVAL) {
        logger.info(`Category [${cat.label}]: Fetching inactive events (8h elapsed)...`);
        inactiveEvents = await fetchCategoryEvents(cat, 'false');
        catState.last_inactive_fetch = nowSec;
      }

      // Save to DB via PHP bridge in batches
      await saveEventsToDb(activeEvents, true);
      if (inactiveEvents.length > 0) {
        await saveEventsToDb(inactiveEvents, false);
      }

      // Discord notification logic
      const previousKnownSet = new Set(catState.known_ids || []);
      const newlyActive = activeEvents.filter(e => !previousKnownSet.has(`${e.id}:${e.date_id}`));

      const webhookUrl = process.env[cat.webhookEnv];
      if (newlyActive.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: Muted ${newlyActive.length} notifications due to silent recovery mode.`);
        } else {
          logger.info(`Category [${cat.label}]: Found ${newlyActive.length} newly active events. Sending notifications...`);
          await sendEventNotifications(webhookUrl, cat.label, cat.headerMessage, newlyActive);
        }
      }

      catState.known_ids = activeEvents.map(e => `${e.id}:${e.date_id}`);
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
