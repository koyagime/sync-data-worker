const crypto = require('crypto');
const { fetchJsonInBrowser, fetchHtmlInBrowser } = require('../browser');
const { postApiSync } = require('../db');
const logger = require('../logger');

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

async function runTournamentResultTask() {
  logger.info('--- Starting Tournament Result & Deck Import Task ---');

  // Fetch feed of recent events with results
  const feedUrl = 'https://players.pokemon-card.com/event_search?order=4&result_resist=1&per_page=25&offset=0&event_type%5B%5D=3%3A1&event_type%5B%5D=3%3A2&event_type%5B%5D=3%3A7';
  const { status, data } = await fetchJsonInBrowser(feedUrl);

  if (status === 404 || !data || !data.event || data.event.length === 0) {
    logger.info('No recent event results found in feed.');
    return;
  }

  const events = data.event;
  logger.info(`Fetched ${events.length} recent result events from feed.`);

  const deckIdSet = new Set();
  const allPlayersToSave = [];

  for (const event of events) {
    const eventHoldingId = event.event_holding_id;
    if (!eventHoldingId) continue;

    try {
      const res = await fetchEventResults(eventHoldingId);
      if (res.status === 'not_published' || !res.results || res.results.length === 0) continue;

      for (const p of res.results) {
        allPlayersToSave.push({
          event_holding_id: eventHoldingId,
          shop_id: event.shop_id || null,
          player_id: p.player_id,
          name: p.name || '',
          rank: p.rank || 0,
          point: p.point || 0,
          area: p.area || null,
          deck_id: p.deck_id ? String(p.deck_id).trim() : null,
          show_profile: p.show_profile || 0,
          tournament_day: event.event_date_params || null
        });

        if (p.deck_id && String(p.deck_id).trim()) {
          deckIdSet.add(String(p.deck_id).trim());
        }
      }
    } catch (err) {
      logger.error(`Error fetching result for event ${eventHoldingId}:`, err.message);
    }
  }

  // Parse deck details
  const decksToSave = [];
  if (deckIdSet.size > 0) {
    logger.info(`Fetching details for ${deckIdSet.size} unique deck IDs...`);
    for (const deckId of deckIdSet) {
      try {
        const url = `https://www.pokemon-card.com/deck/confirm.html/deckID/${encodeURIComponent(deckId)}`;
        const html = await fetchHtmlInBrowser(url);
        const deckData = parseDeckHtml(html);
        const cardsJson = JSON.stringify(deckData.cards);
        const hash = crypto.createHash('sha256').update(cardsJson).digest('hex');

        decksToSave.push({
          deck_id: deckId,
          cards_json: cardsJson,
          card_total: deckData.total,
          cards_hash: hash
        });
      } catch (e) {
        logger.error(`Failed parsing deck [${deckId}]:`, e.message);
      }
    }
  }

  // Post to PHP bridge in batches
  const BATCH_SIZE = 100;
  let totalPlayersSaved = 0;
  let totalDecksSaved = 0;

  for (let i = 0; i < Math.max(allPlayersToSave.length, decksToSave.length); i += BATCH_SIZE) {
    const playerBatch = allPlayersToSave.slice(i, i + BATCH_SIZE);
    const deckBatch = decksToSave.slice(i, i + BATCH_SIZE);

    if (playerBatch.length > 0 || deckBatch.length > 0) {
      const res = await postApiSync('result', {
        players: playerBatch,
        decks: deckBatch
      });
      totalPlayersSaved += (res.players_saved || 0);
      totalDecksSaved += (res.decks_saved || 0);
    }
  }

  logger.info(`Saved ${totalPlayersSaved} players and ${totalDecksSaved} decks to DB.`);
  logger.info('--- Tournament Result & Deck Import Task Completed ---');
}

module.exports = { runTournamentResultTask };
