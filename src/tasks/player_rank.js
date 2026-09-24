const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser } = require('../browser');
const { postApiSync } = require('../db');
const logger = require('../logger');

const STATE_FILE = path.join(__dirname, '../../state/player_rank_state.json');
const LEAGUES = {
  master: 'マスター',
  senior: 'シニア',
  junior: 'ジュニア'
};

/* 1回の実行で読むページ数の上限。
   ⚠ master は全243ページ（約4,860人）。40 のままだと1周に7回＝(scheduleの実測で)丸1日かかる。
      120 にすると3回で1周。1ページごとにブラウザで取りに行くので、1回あたり2〜3分伸びる。
      403 や timeout が増えたら戻すこと。 */
const PAGES_PER_RUN = 120;
const RANKING_PAGE_SIZE = 20;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn('Failed reading player rank state file:', e.message);
  }
  return {};
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    logger.error('Failed writing player rank state file:', e.message);
  }
}

async function runPlayerRankTask() {
  logger.info('--- Starting Player Rank Import Task ---');
  const state = loadState();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  for (const [league, label] of Object.entries(LEAGUES)) {
    try {
      const leagueState = state[league] || {};
      let offset = leagueState.offset || 0;
      let cycleStartedAt = leagueState.cycle_started_at;

      if (!cycleStartedAt) {
        cycleStartedAt = now;
        offset = 0;
        cyclePages = 0;
        logger.info(`Starting new rank fetch cycle for ${label} (${league})...`);
      }

      let pagesFetched = 0;
      let allPlayers = [];
      let reachedEnd = false;
      let totalPages = null;
      /* このサイクルで**これまでに**読んだページ数。master は複数回に分かれるので持ち越す */
      let cyclePages = leagueState.cycle_pages || 0;

      while (pagesFetched < PAGES_PER_RUN) {
        const pageNo = Math.floor(offset / RANKING_PAGE_SIZE) + 1;
        const url = `https://players.pokemon-card.com/get_player_ranking?league=${league}&offset=${offset}&pageNo=${pageNo}`;
        const { status, data } = await fetchJsonInBrowser(url);

        if (status === 404 || !data || !data.result || data.result.length === 0) {
          reachedEnd = true;
          break;
        }

        const players = data.result;

        /* ⚠ 都道府県(prefectureId)が入らない行が出ている（2026-08-07）。
           受け口は `prefectureId` を読む実装で、旧世代の取り込みと同じ項目名・同じURL。
           つまり **API が返しているかどうか**を確かめないと切り分けられないが、
           公式は Cloudflare で守られていて手元からは叩けない。ここが唯一の観測点。
           → 1ページにつき1回だけ、有無と（無いときは）項目名一覧を残す。
           ⚠ 毎行出すとログが埋まるので、**最初の1行だけ**。 */
        if (players.length > 0) {
          const p0 = players[0];
          if (p0 && Object.prototype.hasOwnProperty.call(p0, 'prefectureId')) {
            const filled = players.filter((x) => x && x.prefectureId !== null && x.prefectureId !== undefined).length;
            logger.info(`[prefecture] ${label}(${league}) p${pageNo}: prefectureId あり — ${filled}/${players.length} 件に値が入っている`);
          } else {
            logger.error(`[prefecture] ${label}(${league}) p${pageNo}: **prefectureId が返ってきていない**。実際の項目名: ${Object.keys(p0 || {}).join(', ')}`);
          }
        }

        allPlayers = allPlayers.concat(players);
        pagesFetched++;
        offset += players.length;
        /* 🚨 2026-09-24: 公式の `count` は **ページ数**であって人数ではない。
           実測（ブラウザで get_player_ranking を直接叩いた）:
             master count=243 / senior count=42 / junior count=29
           = 公式の公開ページ(/event/ranking)の「◯ページ中」と一致する。1ページ20人。
           これを人数だと思って `offset(人数) >= count(ページ数)` で打ち切っていたため、
           master は 13ページ=260人で「読み切った」ことになっていた（本当は 243ページ=約4,860人）。
           しかもログには "cycle completed" と出るので、**正常に見えたまま**
           1年近く上位260人しか取り込めていなかった。
           → ページ数どうしで比べる。 */
        if (data.count) totalPages = Number(data.count) || totalPages;

        if (totalPages && cyclePages + pagesFetched >= totalPages) {
          reachedEnd = true;
          break;
        }
      }

      // Sync via PHP bridge in batches
      const BATCH_SIZE = 100;
      let syncResult = { affected: 0, dropped: 0 };
      const pagesInCycle = cyclePages + pagesFetched;
      /* 🚨 `is_end` を送ると、受け口(api_sync.php)が「今回の一覧に居なかった人」を
         **まとめてランキング外**にする。だから「本当に読み切れた時」だけ送る。
         1ページも読めていない / 公式が言うページ数に届いていない = 向こうの不調とみなして送らない。
         （2026-09-24、旧世代の取り込みがこれをやって公開ページから全員が消えた） */
      const trustEnd = reachedEnd
        && pagesInCycle > 0
        && (!totalPages || pagesInCycle >= totalPages);
      if (reachedEnd && !trustEnd) {
        logger.error(`${label} (${league}) ⚠ 公式の一覧を読み切れませんでした（${pagesInCycle}/${totalPages || '?'} ページ）。掲載中の人はそのまま残します`);
      }
      if (allPlayers.length > 0) {
        for (let i = 0; i < allPlayers.length; i += BATCH_SIZE) {
          const batch = allPlayers.slice(i, i + BATCH_SIZE);
          const isLastBatch = (i + BATCH_SIZE >= allPlayers.length);
          const res = await postApiSync('rank', {
            league,
            players: batch,
            is_end: trustEnd && isLastBatch,
            cycle_started_at: cycleStartedAt
          });
          syncResult.affected += (res.affected || 0);
          syncResult.dropped += (res.dropped || 0);
        }
      }

      if (reachedEnd) {
        logger.info(`${label} (${league}) cycle ${trustEnd ? 'completed' : 'aborted'}. Pages: ${pagesInCycle}/${totalPages || '?'}, Processed: ${syncResult.affected || 0}, Dropped: ${syncResult.dropped || 0}.`);
        state[league] = {
          offset: 0,
          cycle_started_at: null,
          cycle_pages: 0,
          last_completed_at: trustEnd ? now : (leagueState.last_completed_at || null),
          last_cycle_total: trustEnd ? offset : (leagueState.last_cycle_total || null)
        };
      } else {
        state[league] = {
          offset,
          cycle_started_at: cycleStartedAt,
          cycle_pages: pagesInCycle,
          last_completed_at: leagueState.last_completed_at || null,
          last_cycle_total: leagueState.last_cycle_total || null
        };
        logger.info(`${label} (${league}) batch fetched ${allPlayers.length} players (pages ${pagesInCycle}/${totalPages || '?'}, offset: ${offset}).`);
      }

      saveState(state);

    } catch (err) {
      logger.error(`Error processing player rank for ${label} (${league}):`, err.message);
    }
  }

  logger.info('--- Player Rank Import Task Completed ---');
}

module.exports = { runPlayerRankTask };
