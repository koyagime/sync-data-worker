const crypto = require('crypto');
const { fetchJsonInBrowser, fetchHtmlInBrowser } = require('../browser');
const { postApiSync, fetchBacklog } = require('../db');

/* 1回の実行で取り残しを何件ぶん追いかけるか。
   多すぎると1回が長くなり、少なすぎると行列が減らない。 */
const BACKLOG_LIMIT = 40;
const DECK_BACKLOG_LIMIT = 120;
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

  /* ⚠ 元々の取り込み(tournament_result_import.php:552 decodeJsValue)と**同じ復元**にする。
     ページの値は JS 文字列なのでエスケープが入り、さらに HTML 実体参照が混ざることがある。
     `\\'` と `\\"` を戻すだけでは、`\\n` や `&amp;` がそのまま名前に残る＝**名前が静かに壊れる**。 */
  const HTML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  const decodeJsValue = (raw) => {
    let s = String(raw);
    /* ① JS のエスケープを解く。JSON として読めれば一番正確。読めなければ最低限だけ戻す。 */
    try {
      s = JSON.parse('"' + s.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"') + '"');
    } catch (e) {
      s = s.replace(/\\(['"\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    /* ② HTML 実体参照を戻す（数値参照も） */
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return Object.prototype.hasOwnProperty.call(HTML_ENT, body) ? HTML_ENT[body] : whole;
    });
  };

  const nameMatches = [...html.matchAll(/PCGDECK\.searchItemName\[(\d+)\]\s*=\s*(["'])((?:\\.|(?!\2).)*)\2/gs)];
  for (const m of nameMatches) {
    nameMap[m[1]] = decodeJsValue(m[3]);
  }

  const imgMatches = [...html.matchAll(/PCGDECK\.searchItemCardPict\[(\d+)\]\s*=\s*(["'])((?:\\.|(?!\2).)*)\2/gs)];
  for (const m of imgMatches) {
    imgMap[m[1]] = decodeJsValue(m[3]);
  }

  const cardsByCategory = {};
  let total = 0;

  for (const [field, category] of Object.entries(categoryFields)) {
    /* ⚠ 2026-08-07 実バグ: `name="deck_pke"` の **直後に value= が来る前提**で書かれていて、
       実物は `name="deck_pke" id="deck_pke" value="…"` と間に id が入るため
       **一度も一致していなかった**。結果、222件のデッキが全部 `{}`(中身ゼロ)で保存されていた。
       → **input タグごと取り出してから value を読む**。属性の順や増減に強い形にする。
       （旧世代の取り込み tournament_deck_import.php:81 は DOM/XPath で取っていて、
         そもそもこの問題が起きない書き方だった） */
    const tag = html.match(new RegExp(`<input[^>]*name=["']${field}["'][^>]*>`, 'i'));
    if (!tag) continue;
    const match = tag[0].match(/value=["']([^"']*)["']/i);
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

  /* ⚠ フィードが空でも **ここで return しない**。
     取り残し（結果公開が遅れた大会）は毎回追いかける必要がある。
     以前はここで抜けていたので、フィードが空の回は何もしていなかった。 */
  const events = (status === 404 || !data || !Array.isArray(data.event)) ? [] : data.event;
  if (events.length === 0) {
    logger.info('No recent event results in feed — going straight to the backlog.');
  } else {
    logger.info(`Fetched ${events.length} recent result events from feed.`);
  }

  const deckIdSet = new Set();
  const allPlayersToSave = [];
  const triedEventIds = new Set();

  /**
   * 1つの大会の結果を取りに行って、保存用の配列に積む。
   * まだ結果ページが無ければ何も積まない（次回また来る）。
   * @returns true = 取れた / false = まだ取れない
   */
  async function collectEvent(event) {
    const eventHoldingId = event.event_holding_id;
    if (!eventHoldingId || triedEventIds.has(String(eventHoldingId))) return false;
    triedEventIds.add(String(eventHoldingId));

    try {
      const res = await fetchEventResults(eventHoldingId);
      if (res.status === 'not_published' || !res.results || res.results.length === 0) return false;

      /* ⚠ tournament_player.shop_id は **NOT NULL**。null を送ると
         「Column 'shop_id' cannot be null」で **そのバッチが丸ごと 500**（2026-08-07 実測）。
         動いている旧世代の取り込み（tournament_result_import.php:1159）と同じ順で解決する:
           フィード/バックログの shop_id → 結果詳細の shopId(キャメル) → 0
         ⚠ 0 は「不明」の印。null にしない。 */
      const shopId = Number(
        event.shop_id ?? event.shopId ?? res.event?.shop_id ?? res.event?.shopId ?? 0
      ) || 0;

      for (const p of res.results) {
        allPlayersToSave.push({
          event_holding_id: eventHoldingId,
          shop_id: shopId,
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
      return true;
    } catch (err) {
      logger.error(`Error fetching result for event ${eventHoldingId}:`, err.message);
      return false;
    }
  }

  for (const event of events) {
    await collectEvent(event);
  }

  /* ── 取り残しを取りに行く（2026-08-07 追加） ────────────────────
     大会の結果ページは **開催日より後のどこか**で、店舗が登録して初めて生成される。
     上のフィードは「結果が公開済みの最新25件」しか返さないので、
     そのとき未公開だった大会は **二度と取りに行かれなかった**。
     → DB 側に「終わったのに1人も取れていない大会」を聞いて、毎回それも回す。
     ⚠ 受け口は **古い順** に返す（新しいものはフィードで拾えるため）。
     ⚠ ここで失敗しても本体は止めない。次の回にまた来ればよい。 */
  const backlog = await fetchBacklog('result_backlog', { limit: BACKLOG_LIMIT });
  if (backlog && Array.isArray(backlog.events) && backlog.events.length > 0) {
    logger.info(`Backlog: ${backlog.total} events still missing results — retrying ${backlog.events.length} (oldest first).`);
    let got = 0;
    for (const e of backlog.events) {
      if (await collectEvent(e)) got++;
    }
    logger.info(`Backlog: newly obtained ${got} / ${backlog.events.length}.`);
  } else if (backlog) {
    /* An empty page is NOT the same as an empty queue: entries that failed recently
       are waiting out their retry backoff. Saying "every event already has results"
       when `total` is 637 hides a growing pile behind a green log line. */
    const waiting = Number(backlog && backlog.total) || 0;
    logger.info(waiting > 0
      ? `Backlog: ${waiting} events still queued, but none are due for a retry yet.`
      : 'Backlog: none — every finished event already has results.');
  }

  /* デッキの取り残しも同じ経路に流す（2026-08-07 追加）。
     これまでは **その回に取れた選手のデッキ**しか見ていなかったので、
     前に保存済みの選手のデッキが欠けていても、二度と取りに行かなかった。 */
  const deckBacklog = await fetchBacklog('deck_backlog', { limit: DECK_BACKLOG_LIMIT });
  if (deckBacklog && Array.isArray(deckBacklog.deck_ids) && deckBacklog.deck_ids.length > 0) {
    const before = deckIdSet.size;
    for (const id of deckBacklog.deck_ids) {
      if (id && String(id).trim()) deckIdSet.add(String(id).trim());
    }
    logger.info(`Deck backlog: ${deckBacklog.total} missing — added ${deckIdSet.size - before} to this run.`);
  }

  /* すでに持っているデッキは公式サイトへ取りに行かない（2026-08-09）。
     以前は毎回「直近20大会の全デッキ」約222件を取り直していた。起動を15分おきに
     変えた直後、公式サイトへの取得が4倍（約888件/時）に膨れ、受け口の api_sync も
     詰まって 60秒タイムアウトが連鎖し、19:00 と 19:15 の実行が丸ごと失敗した。
     ⚠ 判定に失敗したら「全部取りに行く」に倒す（取りこぼすより重い方がまし）。 */
  if (deckIdSet.size > 0) {
    const known = await fetchBacklog('deck_missing', { deck_ids: Array.from(deckIdSet) });
    if (known && Array.isArray(known.missing)) {
      const before = deckIdSet.size;
      const stillNeeded = new Set(known.missing.map(String));
      for (const id of Array.from(deckIdSet)) {
        if (!stillNeeded.has(id)) deckIdSet.delete(id);
      }
      logger.info(`Deck skip: ${before - deckIdSet.size} already stored — fetching ${deckIdSet.size}.`);
    } else {
      logger.warn('deck_missing check unavailable — fetching every deck (heavier, but nothing is lost).');
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

        /* ⚠ 中身が取れなかったものを **保存しない**（2026-08-07）。
           `{}` を書き込むと「行はある」ので取得済みに見え、二度と取り直されなかった。
           取れなかったら黙って捨てず、ログに残して次回また取りに行かせる。 */
        if (!deckData.total || deckData.total <= 0) {
          logger.error(`Deck [${deckId}]: カードを1枚も読み取れなかったので保存しない（次回また取りに行く）`);
          continue;
        }

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
