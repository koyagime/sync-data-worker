const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser } = require('../browser');
const { postApiSync, getPool } = require('../db');
const { sendEventNotifications } = require('../discord');
const logger = require('../logger');

const STATE_FILE = process.env.TOURNAMENT_INFO_STATE_FILE
  || path.join(__dirname, '../../state/tournament_info_state.json');
const RESUME_SILENT_AFTER_SECONDS = parseInt(process.env.RESUME_SILENT_AFTER_SECONDS || '7200', 10);
const INACTIVE_FETCH_INTERVAL = 28800;

/* 🚨 2026-09-28: 通知のたびに全件を取り直していた。
   シティリーグ3ページ + その他大会13ページ = 1回16ページ。5分おき288回/日で約4,600ページ。
   目的は「募集開始・空き枠が出た」ことを**すぐ**知らせることなので、
   まず **総数だけ**を聞いて（1カテゴリ2リクエスト）、動いたときに全件を見に行く。

   ⚠ 「1ページ目だけ見る」は**使えない**（2026-09-28 実測）。
      `order=1` は開催日の昇順（09/29, 09/29, 10/03…）、`order=4` は降順。
      **更新順に並べる指定は見つからなかった**ので、新しく開いた大会が1ページ目に来る保証がない。
      一方 `eventCount` は総数そのものなので、増減は確実に判る。

   ⚠ 「1つ閉じて1つ開く」が同じ窓に入ると受付中の総数が動かない。
      そのため **受付終了の総数が増えた**ときも全件を見る（閉じた＝入れ替わりの可能性）。 */
const FULL_SCAN_INTERVAL = parseInt(process.env.FULL_SCAN_INTERVAL || '1800', 10);   /* 何も動かなくても30分に1回は全件 */

const CATEGORIES = {
  city_league: {
    label: 'シティリーグ',
    event_attr_id: 3,
    event_type: 2,
    params: { 'event_type[]': '3:2', order: '1' },
    headerMessage: '🔔 **【シティリーグ】の募集が開始/空き枠が発生しました！**',
    webhookEnv: 'DISCORD_CITY_WEBHOOK'
  },
  other_events: {
    label: 'その他大会',
    event_attr_id: 3,
    event_type: 7,
    params: { 'event_type[]': '3:7', order: '1' },
    headerMessage: '🔔 **【その他大会】の募集が開始/空き枠が発生しました！**',
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

/**
 * 総数だけを聞く（1カテゴリ 2リクエスト）。offset=0 の返りに `eventCount`（総数）が入っている。
 * @returns {{t:number|null, f:number|null}} 受付中 / 受付終了 の総数。読めなければ null
 */
async function probeCounts(catConfig) {
  const queryStr = Object.entries(catConfig.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const one = async (accepting) => {
    const { status, data } = await fetchJsonInBrowser(`https://players.pokemon-card.com/event_search?${queryStr}&accepting=${accepting}&offset=0`);
    if (status === 404) return 0;                       /* 該当0件。エラーではない */
    if (!data || typeof data.eventCount !== 'number') return null;
    return data.eventCount;
  };
  return { t: await one('true'), f: await one('false') };
}

/** 全件を見に行くべきか。理由も返す（ログに出して後から追えるように） */
function decideFullScan(prev, probe, sinceFullSec, forceNotify) {
  if (forceNotify) return { need: true, why: 'FORCE_NOTIFY' };
  if (!prev) return { need: true, why: '前回の総数を持っていない' };
  if (probe.t === null || probe.f === null) return { need: true, why: '総数が読めなかった' };
  if (probe.t !== prev.t) return { need: true, why: `受付中が ${prev.t} → ${probe.t}` };
  if (probe.f > prev.f) return { need: true, why: `受付終了が ${prev.f} → ${probe.f}（入れ替わりの可能性）` };
  if (sinceFullSec >= FULL_SCAN_INTERVAL) return { need: true, why: `前回の全件から ${Math.floor(sinceFullSec / 60)} 分` };
  return { need: false, why: `受付中 ${probe.t} / 受付終了 ${probe.f} のまま` };
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
  const forceNotify = process.env.FORCE_NOTIFY === 'true';

  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    try {
      const catState = state[catKey] || {};
      const lastSuccess = catState.last_success || 0;
      const shouldStaySilent = !forceNotify && ((lastSuccess === 0) || ((nowSec - lastSuccess) > RESUME_SILENT_AFTER_SECONDS));

      if (shouldStaySilent) {
        logger.info(`Category [${cat.label}]: Silent recovery active.`);
      } else if (forceNotify) {
        logger.info(`Category [${cat.label}]: FORCE_NOTIFY active. Dispatching all active events to regional Discord channels.`);
      }

      /* まず総数だけ聞く。動いていなければここで終わり（1カテゴリ2リクエスト） */
      const probe = await probeCounts(cat);
      const verdict = decideFullScan(catState.counts || null, probe, nowSec - (catState.last_full_scan || 0), forceNotify);
      catState.counts = probe;
      if (!verdict.need) {
        logger.info(`Category [${cat.label}]: 変化なし（${verdict.why}）。全件は見ません`);
        state[catKey] = catState;
        saveState(state);
        continue;
      }
      logger.info(`Category [${cat.label}]: 全件を見ます — ${verdict.why}`);

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
      const newlyActive = forceNotify ? activeEvents : activeEvents.filter(e => !previousKnownSet.has(`${e.id}:${e.date_id}`));

      const webhookUrl = process.env[cat.webhookEnv];
      if (newlyActive.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: Muted ${newlyActive.length} notifications due to silent recovery mode.`);
        } else {
          logger.info(`Category [${cat.label}]: Found ${newlyActive.length} newly active events. Sending notifications to regional Webhooks...`);
          await sendEventNotifications(webhookUrl, cat.label, cat.headerMessage, newlyActive);
        }
      }

      catState.known_ids = activeEvents.map(e => `${e.id}:${e.date_id}`);
      catState.last_success = nowSec;
      catState.last_full_scan = nowSec;
      state[catKey] = catState;
      saveState(state);

    } catch (err) {
      logger.error(`Error processing category [${cat.label}]:`, err.message);
    }
  }

  logger.info('--- Tournament Info Task Completed ---');
}

module.exports = { runTournamentInfoTask, decideFullScan, FULL_SCAN_INTERVAL };
