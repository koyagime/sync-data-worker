const fs = require('fs');
const path = require('path');
const { fetchJsonInBrowser } = require('../browser');
const { getPool } = require('../db');
const logger = require('../logger');

const STATE_FILE = path.join(__dirname, '../../state/player_rank_state.json');
const LEAGUES = {
  master: 'マスター',
  senior: 'シニア',
  junior: 'ジュニア'
};

const PAGES_PER_RUN = 40;
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

async function syncLeaguePlayers(pool, league, players) {
  if (!players || players.length === 0) return { processed: 0, newCount: 0, updatedCount: 0 };

  const [existingRows] = await pool.query(
    `SELECT player_id, nickname, current_league_id, current_ranking, prefecture_id, champion_ship_point, public_flg, champion_flg, avatar_image, is_listed FROM tournament_player_rank WHERE league = ?`,
    [league]
  );
  const existingMap = new Map();
  for (const r of existingRows) {
    existingMap.set(String(r.player_id), r);
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let processed = 0;
  let newCount = 0;
  let updatedCount = 0;

  const sql = `
    INSERT INTO tournament_player_rank (
      id, league, player_id, nickname, current_league_id, current_ranking,
      previous_ranking, prefecture_id, champion_ship_point, public_flg,
      champion_flg, avatar_image, is_listed, last_rank_change_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, 1, ?
    )
    ON DUPLICATE KEY UPDATE
      id = VALUES(id),
      nickname = VALUES(nickname),
      current_league_id = VALUES(current_league_id),
      previous_ranking = VALUES(previous_ranking),
      current_ranking = VALUES(current_ranking),
      prefecture_id = VALUES(prefecture_id),
      champion_ship_point = VALUES(champion_ship_point),
      public_flg = VALUES(public_flg),
      champion_flg = VALUES(champion_flg),
      avatar_image = VALUES(avatar_image),
      is_listed = 1,
      last_rank_change_at = CASE
        WHEN current_ranking IS NULL OR current_ranking <> VALUES(current_ranking)
          THEN VALUES(last_rank_change_at)
        ELSE last_rank_change_at
      END,
      updated_at = NOW()
  `;

  for (const p of players) {
    const playerId = p.playerId ? String(p.playerId) : '';
    const ranking = p.currentRanking !== undefined ? parseInt(p.currentRanking, 10) : null;
    if (!playerId || ranking === null) continue;

    processed++;
    const existing = existingMap.get(playerId);
    const prevRanking = existing ? existing.current_ranking : null;

    if (existing) {
      updatedCount++;
    } else {
      newCount++;
    }

    const params = [
      p.id || 0,
      league,
      playerId,
      p.nickname || '',
      p.currentLeagueId || null,
      ranking,
      prevRanking,
      p.prefectureId || null,
      p.championShipPoint || null,
      p.publicFlg || null,
      p.championFlg || null,
      p.avatarImage || null,
      now
    ];

    try {
      await pool.query(sql, params);
    } catch (err) {
      logger.error(`Error saving player rank (${playerId}):`, err.message);
    }
  }

  return { processed, newCount, updatedCount };
}

async function runPlayerRankTask() {
  logger.info('--- Starting Player Rank Import Task ---');
  const pool = getPool();
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
        logger.info(`Starting new rank fetch cycle for ${label} (${league})...`);
      }

      let pagesFetched = 0;
      let allPlayers = [];
      let reachedEnd = false;
      let totalCount = null;

      while (pagesFetched < PAGES_PER_RUN) {
        const pageNo = Math.floor(offset / RANKING_PAGE_SIZE) + 1;
        const url = `https://players.pokemon-card.com/get_player_ranking?league=${league}&offset=${offset}&pageNo=${pageNo}`;
        const { status, data } = await fetchJsonInBrowser(url);

        if (status === 404 || !data || !data.result || data.result.length === 0) {
          reachedEnd = true;
          break;
        }

        const players = data.result;
        allPlayers = allPlayers.concat(players);
        pagesFetched++;
        offset += players.length;
        if (data.count) totalCount = data.count;

        if (totalCount && offset >= totalCount) {
          reachedEnd = true;
          break;
        }
      }

      const syncResult = await syncLeaguePlayers(pool, league, allPlayers);

      if (reachedEnd) {
        // Finalize unlisted players for this cycle
        const [res] = await pool.query(
          `UPDATE tournament_player_rank SET is_listed = 0 WHERE league = ? AND updated_at < ? AND is_listed = 1`,
          [league, cycleStartedAt]
        );
        logger.info(`${label} (${league}) cycle completed. Processed: ${syncResult.processed}, Dropped/Unlisted: ${res.affectedRows}.`);
        state[league] = {
          offset: 0,
          cycle_started_at: null,
          last_completed_at: now,
          last_cycle_total: offset
        };
      } else {
        state[league] = {
          offset,
          cycle_started_at: cycleStartedAt,
          last_completed_at: leagueState.last_completed_at || null,
          last_cycle_total: leagueState.last_cycle_total || null
        };
        logger.info(`${label} (${league}) batch fetched ${allPlayers.length} players (offset: ${offset}).`);
      }

      saveState(state);

    } catch (err) {
      logger.error(`Error processing player rank for ${label} (${league}):`, err.message);
    }
  }

  logger.info('--- Player Rank Import Task Completed ---');
}

module.exports = { runPlayerRankTask };
