const axios = require('axios');
const logger = require('./logger');

const MAX_DISCORD_MSG_LEN = 1900;
const MAX_RETRIES = 3;

/**
 * Builds detail URL for official event page
 */
function buildEventDetailUrl(event) {
  const { event_holding_id, recruitFlg, shop_id, event_date_params, date_id } = event;
  if (!event_holding_id || recruitFlg === undefined || !shop_id || !event_date_params || !date_id) {
    return null;
  }
  return `https://players.pokemon-card.com/event/detail/${encodeURIComponent(event_holding_id)}/${encodeURIComponent(recruitFlg)}/${encodeURIComponent(shop_id)}/${encodeURIComponent(event_date_params)}/${encodeURIComponent(date_id)}`;
}

/**
 * Formats a single tournament entry into readable text for Discord notification
 */
function formatEventNotificationText(event) {
  const title = event.event_title || '（無題の大会）';
  const pref = event.prefecture_name || '';
  const league = event.leagueName || '';
  const locationTag = [pref, league].filter(Boolean).join(' / ');
  const shop = event.shop_name || event.venue || '（会場未定）';

  let dateStr = event.event_date || '';
  if (event.event_date_week) {
    dateStr += ` (${event.event_date_week})`;
  }
  const timeStr = [event.event_started_at, event.event_ended_at].filter(Boolean).join('〜');
  const fullDateTime = [dateStr, timeStr].filter(Boolean).join(' ');

  const entryStatus = event.entryStatus || '受付中';
  const cap = event.capacity ? `定員: ${event.capacity}名` : '';
  const reg = event.regulation ? `レギュ: ${event.regulation}` : '';
  const deck = event.deck_count ? `構築: ${event.deck_count}` : '';
  const fee = event.entry_fee ? `参加費: ${event.entry_fee}` : '';
  const metaLine = [entryStatus, cap, reg, deck, fee].filter(Boolean).join(' / ');

  const url = buildEventDetailUrl(event);
  const urlLine = url ? `<${url}>` : ''; // Surrounding with <> disables embed preview in Discord markdown

  return `・【${locationTag || '全国'}】${shop}\n  大会名：${title}\n  日時：${fullDateTime}\n  詳細：${metaLine}\n  ${urlLine}\n`;
}

/**
 * Posts payload to Discord Webhook with 429 Retry handling
 */
async function postDiscordWebhook(webhookUrl, content) {
  const isDryRun = process.env.PM_NOTIFY_DRYRUN === 'true';

  if (isDryRun || !webhookUrl) {
    logger.info(`[DRY-RUN / NO-WEBHOOK] Discord Payload:\n${content}`);
    return true;
  }

  const payload = {
    content,
    flags: 4 // SUPPRESS_EMBEDS (prevents duplicated automatic card previews)
  };

  let attempt = 0;
  let delay = 1000;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      await axios.post(webhookUrl, payload, { timeout: 10000 });
      return true;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const retryAfter = (err.response.data && err.response.data.retry_after) || 2;
        logger.warn(`Discord Rate Limit (429). Waiting ${retryAfter}s before retry (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000 + 500));
        continue;
      }

      logger.error(`Discord post failed (attempt ${attempt}/${MAX_RETRIES}):`, err.message);
      if (attempt >= MAX_RETRIES) break;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }

  return false;
}

/**
 * Splits list of events into chunks under 1900 chars and posts to Discord
 */
async function sendEventNotifications(webhookUrl, categoryLabel, headerMessage, events) {
  if (!events || events.length === 0) return;

  const chunks = [];
  let currentChunk = headerMessage + '\n\n';

  for (const event of events) {
    const text = formatEventNotificationText(event);

    if ((currentChunk.length + text.length) > MAX_DISCORD_MSG_LEN) {
      chunks.push(currentChunk.trim());
      currentChunk = headerMessage + '\n\n' + text;
    } else {
      currentChunk += text;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  logger.info(`Sending ${events.length} notification entries for ${categoryLabel} in ${chunks.length} Discord message chunk(s)...`);

  for (let i = 0; i < chunks.length; i++) {
    await postDiscordWebhook(webhookUrl, chunks[i]);
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 1000)); // Sleep between chunks
    }
  }
}

module.exports = {
  buildEventDetailUrl,
  formatEventNotificationText,
  sendEventNotifications,
  postDiscordWebhook
};
