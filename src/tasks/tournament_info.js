const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser, getSessionInfo } = require('../browser');
const { readEventCount, readOfficialTotal, isOfficialEmpty, unreadableError } = require('../upstream_check');
const { postApiSync, getPool } = require('../db');
const { sendEventNotifications } = require('../discord');
const { notifyApp } = require('../app_push');
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

/* 🚨 全件を見ている最中に次の回が始まると、両方が「変わった」と判断して**同じ通知を2回**送る。
   3分おきになったので現実的な話（全件は遅いと2分以上かかる）。
   → 見に行く前に「いま見ている」印を残し、次の回はそれを見て譲る。
   印が古くなったら（＝前の回が落ちた）やり直す。 */
const SCAN_LOCK_SECONDS = parseInt(process.env.SCAN_LOCK_SECONDS || '300', 10);

/* 🚩 「公式に入れたか」の証拠（2026-11-23）。絞り込み無し・受付終了を含む全大会の総数。
   実測 2026-11-23: eventCount=9515。全国の全大会なのでシーズンの切れ目でも0にならない。
   1回あたり1リクエスト増える（総数だけを見る。全件は取らない）。 */
const OFFICIAL_TOTAL_URL = 'https://players.pokemon-card.com/event_search?order=1&accepting=false&offset=0';

const CATEGORIES = {
  city_league: {
    label: 'シティリーグ',
    event_attr_id: 3,
    event_type: 2,
    params: { 'event_type[]': '3:2', order: '1' },
    headerMessage: '🔔 **【シティリーグ】の募集が開始/空き枠が発生しました！**',
    webhookEnv: 'DISCORD_CITY_WEBHOOK',
    /* 🚨 2026-10-20: シティリーグは**毎回まるごと見る**。
       受付中の一覧に満席の大会が居座るので（実測4件中1件）、総数だけ見ていると
       「満席が解けた＝キャンセルで空いた」に気づけない。
       受付中は1〜3ページしかないので、総数を2回聞くのとほぼ同じ手間で済む。
       その他大会は13ページあるので、そちらは総数の見張りのまま。 */
    scanAlways: true
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
    const res = await fetchJsonInBrowser(url);
    const { data } = res;

    /* ⚠ 2026-11-23: 以前は「404・中身が無い・形が違う」を全部「終わり」にしていた＝**読めなくても0件**に見えた。
       終わりは「公式の0件の返事（404 の JSON）」か「空の配列」だけ。それ以外は読めていない */
    if (isOfficialEmpty(res)) break;
    if (readEventCount(res) === null) {
      throw unreadableError(`大会の一覧の返事の形が違う（${catConfig.label}・HTTP ${res.status}・offset ${offset}）`);
    }
    if (data.event.length === 0) break;

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
    const res = await fetchJsonInBrowser(`https://players.pokemon-card.com/event_search?${queryStr}&accepting=${accepting}&offset=0`);
    /* 0件は公式の 404 の JSON のときだけ。⚠ 以前は 404 なら何でも0にしていた（読めない 404 も0件に見えた） */
    return readEventCount(res);
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

/** @returns {Array} 受け口が見つけた「満席が解けた」大会（公式への取得は増えない） */
/* 公式の「受付中の一覧」（accepting=true）には、まだ受付前の大会（先着受付前・抽選受付前）も入る（2026-11-25 東京の受付前 85件すべてで確認）。
   本当に応募できるのは「受付中」で「満席」でないときだけ */
function isEntryOpen(e) {
  const s = String((e && (e.entryStatus || e.entry_status)) || '');
  return s.includes('受付中') && !s.includes('満席');
}

/**
 * 受け口（api_sync.php）へ書く。返事の freed（満席が解けた）と opened（受付前 → 受付中に変わった・2026-11-25 から）を集めて返す。
 * ⚠ 古い受け口は opened を返さない → 空のまま（受付開始は送られないが、害は無い）
 * @returns {Promise<{freed: object[], opened: object[]}>}
 */
async function saveEventsToDb(events, isActive) {
  if (!events || events.length === 0) return { freed: [], opened: [] };

  const formattedEvents = events.map(e => ({
    ...e,
    event_date_params: formatSqlDate(e.event_date_params)
  }));

  const BATCH_SIZE = 100;
  const freed = [];
  const opened = [];
  for (let i = 0; i < formattedEvents.length; i += BATCH_SIZE) {
    const batch = formattedEvents.slice(i, i + BATCH_SIZE);
    logger.info(`Sending batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(formattedEvents.length / BATCH_SIZE)} (${batch.length} events)...`);
    const res = await postApiSync('info', { events: batch, is_active: isActive });
    if (res && Array.isArray(res.freed)) freed.push(...res.freed);
    if (res && Array.isArray(res.opened)) opened.push(...res.opened);
  }
  return { freed, opened };
}

/**
 * 公式に入れたかを確かめる（総数だけ・1リクエスト）。
 * @returns {Promise<{ok:boolean, total:number|null, reason:string}>}
 */
async function probeOfficialTotal() {
  try {
    return readOfficialTotal(await fetchJsonInBrowser(OFFICIAL_TOTAL_URL));
  } catch (err) {
    return { ok: false, total: null, reason: `公式の総数を取りに行けなかった: ${err.message}` };
  }
}

/**
 * @returns {Promise<{readOk:boolean, total:number|null, reason:string, detail:string, title:string}>}
 *   readOk=false は「公式を読めなかった」。index.js が連続失敗として数え、生きている印に「失敗」と送る。
 *   ⚠ 受付中が本当に0件でも readOk は true（総数が読めているので）。ここで「0件」と「入れず0件」を分ける
 */
async function runTournamentInfoTask() {
  logger.info('--- Starting Tournament Info Task ---');

  /* 🚩 まず公式に入れたかを確かめる（2026-11-23）。入れなければ大会の一覧は取りに行かない
     （読めない回に取りに行っても「0件」に見えるだけで、向こうを押し返すことにもなる。2026-09-28 と同じ考え） */
  const official = await probeOfficialTotal();
  const title = (getSessionInfo && getSessionInfo().title) || '';
  if (!official.ok) {
    logger.warn(`公式を読めませんでした: ${official.reason}（最初の頁の題名「${title}」）。この回は大会の一覧を取りに行きません`);
    logger.info('--- Tournament Info Task Completed (公式を読めず) ---');
    return { readOk: false, total: official.total, reason: official.reason, detail: '', title };
  }
  logger.info(`公式を読めました: 全大会の総数（受付終了を含む）${official.total} 件`);

  const problems = [];
  const seen = {};
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

      /* シティリーグは毎回まるごと見る（上の scanAlways の理由）。総数は聞かない */
      /* シティリーグは毎回まるごと見る（上の scanAlways の理由）。総数は聞かない */
      let probe = null;
      if (!cat.scanAlways) {
        /* まず総数だけ聞く。動いていなければここで終わり（1カテゴリ2リクエスト） */
        probe = await probeCounts(cat);
        const verdict = decideFullScan(catState.counts || null, probe, nowSec - (catState.last_full_scan || 0), forceNotify);
        if (!verdict.need) {
          catState.counts = probe;
          seen[cat.label] = `受付中 ${probe.t}`;
          logger.info(`Category [${cat.label}]: 変化なし（${verdict.why}）。全件は見ません`);
          state[catKey] = catState;
          saveState(state);
          continue;
        }
        logger.info(`Category [${cat.label}]: 全件を見ます — ${verdict.why}`);
      } else {
        logger.info(`Category [${cat.label}]: 毎回まるごと見ます（満席が解けたのを拾うため）`);
      }

      /* ⚠ 二重に通知しないための印は **どちらの道でも**要る。
         2026-10-20: scanAlways の道だけ印を見ていなかった＝シティリーグが重なると
         同じ空き枠を2回知らせる形になっていた（計器で捕まえた）。 */
      const lockAge = nowSec - (catState.scan_started_at || 0);
      if (catState.scan_started_at && lockAge < SCAN_LOCK_SECONDS) {
        /* ⚠ ここで counts を**書き換えない**。書き換えると「変わった」が消えて、
           譲った先が落ちたときに誰も見に行かなくなる（2026-09-28 計器で捕まえた）。 */
        logger.info(`Category [${cat.label}]: 別の回が全件を見ています（${lockAge}秒前に開始）。譲ります`);
        continue;
      }
      if (probe) catState.counts = probe;
      catState.scan_started_at = nowSec;          /* 先に印を置く（保存してから見に行く） */
      state[catKey] = catState;
      saveState(state);

      const activeEvents = await fetchCategoryEvents(cat, 'true');
      logger.info(`Category [${cat.label}]: Fetched ${activeEvents.length} active events.`);
      seen[cat.label] = `受付中 ${activeEvents.length}`;

      const lastInactiveFetch = catState.last_inactive_fetch || 0;
      let inactiveEvents = [];
      if ((nowSec - lastInactiveFetch) >= INACTIVE_FETCH_INTERVAL) {
        logger.info(`Category [${cat.label}]: Fetching inactive events (8h elapsed)...`);
        inactiveEvents = await fetchCategoryEvents(cat, 'false');
        catState.last_inactive_fetch = nowSec;
      }

      // Save to DB via PHP bridge in batches
      const { freed, opened } = await saveEventsToDb(activeEvents, true);
      if (inactiveEvents.length > 0) {
        await saveEventsToDb(inactiveEvents, false);
      }

      // Discord notification logic
      const previousKnownSet = new Set(catState.known_ids || []);
      const newlyActive = forceNotify ? activeEvents : activeEvents.filter(e => !previousKnownSet.has(`${e.id}:${e.date_id}`));

      const webhookUrl = process.env[cat.webhookEnv];

      /* 🚨 「満席が解けた」= キャンセルで空いた枠。一覧には載ったままなので newlyActive には出ない。
         受け口が前の値と見比べて教えてくれる（公式への取得は増えない）。 */
      if (freed.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: 満席が解けた ${freed.length} 件は、復帰直後なので知らせません`);
        } else {
          logger.info(`Category [${cat.label}]: 満席が解けた大会 ${freed.length} 件。知らせます`);
          await sendEventNotifications(webhookUrl, cat.label, `🔔 **【${cat.label}】満席だった大会に空きが出ました！**`, freed);
          /* アプリへ: シティリーグは city_freed。その他大会は other_freed（受け取りを選んだ端末だけに届く・2026-11-02 運営「その他大会も通知欲しい」。
             受け取る端末の側で1台4件以上は1通にまとめる＝鳴りすぎない） */
          if (catKey === 'city_league') await notifyApp('city_freed', freed);
          else if (catKey === 'other_events') await notifyApp('other_freed', freed);
        }
      }

      /* 🚨 2026-11-25 運営「先着受付前でも通知来る？募集中だけ通知って可能？」: 受付前で一覧に載った大会は、本当に受付中になった時に
         ここ（受け口が前の状態と見比べて opened で教える）で「受付開始」を送る。新しく載った時は下で city_soon（受付前）として送る。
         Discord は今までどおり（変えない） */
      if (opened.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: 受付が始まった ${opened.length} 件は、復帰直後なので知らせません`);
        } else {
          logger.info(`Category [${cat.label}]: 受付が始まった大会 ${opened.length} 件。アプリに知らせます`);
          if (catKey === 'city_league') await notifyApp('city_new', opened);
          else if (catKey === 'other_events') await notifyApp('other_new', opened);
        }
      }

      if (newlyActive.length > 0) {
        if (shouldStaySilent) {
          logger.info(`Category [${cat.label}]: Muted ${newlyActive.length} notifications due to silent recovery mode.`);
        } else {
          logger.info(`Category [${cat.label}]: Found ${newlyActive.length} newly active events. Sending notifications to regional Webhooks...`);
          await sendEventNotifications(webhookUrl, cat.label, cat.headerMessage, newlyActive);
          /* ⚠ FORCE_NOTIFY（全件を流し直す）のときはアプリに送らない。端末に何十通も届く */
          /* 新しく載った大会: もう受付中なら「受付開始」（city_new）、まだ受付前なら「新しい大会（受付前）」（city_soon）。
             受付前だった大会は、受付中になった時に上の opened で「受付開始」が届く */
          const nowOpen = newlyActive.filter(isEntryOpen);
          const notYet = newlyActive.filter((e) => !isEntryOpen(e));
          if (catKey === 'city_league' && !forceNotify) {
            await notifyApp('city_new', nowOpen);
            await notifyApp('city_soon', notYet);
          } else if (catKey === 'other_events' && !forceNotify) {
            await notifyApp('other_new', nowOpen);
            await notifyApp('other_soon', notYet);
          }
        }
      }

      catState.known_ids = activeEvents.map(e => `${e.id}:${e.date_id}`);
      catState.last_success = nowSec;
      catState.last_full_scan = nowSec;
      catState.scan_started_at = 0;               /* 見終わったので印を外す */
      state[catKey] = catState;
      saveState(state);

    } catch (err) {
      /* ⚠ 2026-11-23: 以前はここで飲み込むだけで、読めなくても「成功」で終わっていた。理由を持ち帰る */
      problems.push(`${cat.label}: ${err.message}`);
      logger.error(`Error processing category [${cat.label}]:`, err.message);
    }
  }

  logger.info('--- Tournament Info Task Completed ---');
  const detail = `全大会 ${official.total}件` + Object.entries(seen).map(([k, v]) => `・${k} ${v}`).join('');
  if (problems.length) {
    return { readOk: false, total: official.total, reason: problems.join(' / ').slice(0, 300), detail, title };
  }
  return { readOk: true, total: official.total, reason: '', detail, title };
}

module.exports = { runTournamentInfoTask, decideFullScan, FULL_SCAN_INTERVAL, OFFICIAL_TOTAL_URL, isEntryOpen };
