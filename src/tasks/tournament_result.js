const crypto = require('crypto');
const { fetchJsonInBrowser, fetchHtmlInBrowser } = require('../browser');
const { getPool } = require('../db');
const logger = require('../logger');

async function fetchPendingEventsFromInfo(pool) {
  const sql = `
    SELECT
      ti.event_holding_id,
      ti.event_date_params,
      ti.shop_id,
      ti.event_title
    FROM tournament_info ti
    WHERE ti.event_holding_id IS NOT NULL
      AND ti.event_holding_id <> 0
      AND ti.event_attr_id = 3
      AND ti.event_type = 2
      AND ti.event_date_params <= CURDATE()
      AND NOT EXISTS (
        SELECT 1 FROM tournament_player tp WHERE tp.event_holding_id = ti.event_holding_id
      )
    ORDER BY ti.event_date_params DESC, ti.updated_at DESC
  `;
  const [rows] = await pool.query(sql);
  return rows.map(r => ({
    event_holding_id: parseInt(r.event_holding_id, 10),
    event_date_params: r.event_date_params,
    shop_id: r.shop_id ? parseInt(r.shop_id, 10) : null,
    event_title: r.event_title || ''
  }));
}

async function fetchEventResults(eventId) {
  let offset = 0;
  let allResults = [];
  let eventMeta = null;

  while (true) {
    const url = `https://players.pokemon-card.com/event_result_detail_search?event_holding_id=${encodeURIComponent(eventId)}&offset=${offset}&per_page=100`;
    const { status, data } = await fetchJsonInBrowser(url);

    if (status === 404 || !data) {
      return { status: 'not_published', results: [] };
    }

    if (!eventMeta && data.event) {
      eventMeta = data.event;
    }

    const pageResults = data.results || [];
    allResults = allResults.concat(pageResults);
    const count = data.count || pageResults.length;
    offset += pageResults.length;

    if (pageResults.length === 0 || offset >= count) {
      break;
    }
  }

  return { status: 'ok', event: eventMeta, results: allResults };
}

async function upsertPlayers(pool, eventId, shopId, eventDate, results) {
  if (!results || results.length === 0) return 0;

  const sql = `
    INSERT INTO tournament_player (
      event_holding_id, shop_id, player_id, name, rank, point, area, deck_id, show_profile, tournament_day
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON DUPLICATE KEY UPDATE
      shop_id = VALUES(shop_id),
      name = VALUES(name),
      rank = VALUES(rank),
      point = VALUES(point),
      area = VALUES(area),
      deck_id = VALUES(deck_id),
      show_profile = VALUES(show_profile),
      tournament_day = VALUES(tournament_day),
      updated_at = NOW()
  `;

  let count = 0;
  for (const p of results) {
    const deckId = p.deck_id ? String(p.deck_id).trim() : null;
    const params = [
      eventId,
      shopId,
      p.player_id,
      p.name || '',
      p.rank || 0,
      p.point || 0,
      p.area || null,
      deckId || null,
      p.show_profile || 0,
      eventDate || null
    ];
    try {
      await pool.query(sql, params);
      count++;
    } catch (err) {
      logger.error(`Error upserting player ${p.player_id} for event ${eventId}:`, err.message);
    }
  }
  return count;
}

function parseDeckHtml(html) {
  const categoryFields = {
    deck_pke: 'Pokemon',
    deck_gds: 'Goods',
    deck_tool: 'Pokemon Tool',
    deck_tech: 'Pokemon Tool',
    deck_sup: 'Support',
    deck_sta: 'Stadium',
    deck_ene: 'Energy',
    deck_ajs: 'Other'
  };

  const nameMap = {};
  const imgMap = {};

  const nameMatches = [...html.matchAll(/PCGDECK\.searchItemName\[(\d+)\]\s*=\s*(["'])(.*?)\2/gs)];
  for (const m of nameMatches) {
    nameMap[m[1]] = m[3].replace(/\\'/g, "'").replace(/\\"/g, '"');
  }

  const imgMatches = [...html.matchAll(/PCGDECK\.searchItemCardPict\[(\d+)\]\s*=\s*(["'])(.*?)\2/gs)];
  for (const m of imgMatches) {
    imgMap[m[1]] = m[3].replace(/\\'/g, "'").replace(/\\"/g, '"');
  }

  const cardsByCategory = {};
  let total = 0;

  for (const [field, category] of Object.entries(categoryFields)) {
    const fieldRegex = new RegExp(`name=["']${field}["']\\s+value=["'](.*?)["']`, 'i');
    const match = html.match(fieldRegex);
    if (!match || !match[1]) continue;

    const tokens = match[1].split('-');
    for (const token of tokens) {
      const parts = token.split('_');
      if (parts.length < 2) continue;
      const cardId = parts[0];
      const count = parseInt(parts[1], 10);
      if (!cardId || isNaN(count) || count <= 0) continue;

      if (!cardsByCategory[category]) cardsByCategory[category] = [];
      cardsByCategory[category].push({
        card_id: cardId,
        count,
        name: nameMap[cardId] || null,
        image_url: imgMap[cardId] || null
      });
      total += count;
    }
  }

  return { cards: cardsByCategory, total };
}

async function processDeck(pool, deckId) {
  try {
    const url = `https://www.pokemon-card.com/deck/confirm.html/deckID/${encodeURIComponent(deckId)}`;
    const html = await fetchHtmlInBrowser(url);
    const deckData = parseDeckHtml(html);

    const cardsJson = JSON.stringify(deckData.cards);
    const hash = crypto.createHash('sha256').update(cardsJson).digest('hex');

    const sql = `
      INSERT INTO tournament_decks (deck_id, cards_json, card_total, cards_hash)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        cards_json = IF(cards_hash <> VALUES(cards_hash), VALUES(cards_json), cards_json),
        card_total = IF(cards_hash <> VALUES(cards_hash), VALUES(card_total), card_total),
        cards_hash = IF(cards_hash <> VALUES(cards_hash), VALUES(cards_hash), cards_hash),
        updated_at = IF(cards_hash <> VALUES(cards_hash), CURRENT_TIMESTAMP, updated_at)
    `;

    await pool.query(sql, [deckId, cardsJson, deckData.total, hash]);
    logger.info(`Deck [${deckId}] saved (${deckData.total} cards).`);
  } catch (err) {
    logger.error(`Error processing deck [${deckId}]:`, err.message);
  }
}

async function runTournamentResultTask() {
  logger.info('--- Starting Tournament Result & Deck Import Task ---');
  const pool = getPool();

  const pendingEvents = await fetchPendingEventsFromInfo(pool);
  logger.info(`Found ${pendingEvents.length} pending events to fetch results for.`);

  const deckIdSet = new Set();

  for (const event of pendingEvents) {
    try {
      logger.info(`Fetching result for event_holding_id=${event.event_holding_id} (${event.event_title})...`);
      const { status, results } = await fetchEventResults(event.event_holding_id);

      if (status === 'not_published' || !results || results.length === 0) {
        logger.info(`Results for event ${event.event_holding_id} not published yet.`);
        continue;
      }

      const count = await upsertPlayers(pool, event.event_holding_id, event.shop_id, event.event_date_params, results);
      logger.info(`Saved ${count} players for event_holding_id=${event.event_holding_id}.`);

      for (const p of results) {
        if (p.deck_id && String(p.deck_id).trim()) {
          deckIdSet.add(String(p.deck_id).trim());
        }
      }

    } catch (err) {
      logger.error(`Error fetching result for event ${event.event_holding_id}:`, err.message);
    }
  }

  // Process unique decks
  if (deckIdSet.size > 0) {
    logger.info(`Processing ${deckIdSet.size} unique deck IDs...`);
    for (const deckId of deckIdSet) {
      await processDeck(pool, deckId);
    }
  }

  logger.info('--- Tournament Result & Deck Import Task Completed ---');
}

module.exports = { runTournamentResultTask };
