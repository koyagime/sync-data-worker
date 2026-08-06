const axios = require('axios');
const logger = require('./logger');

const MAX_EMBEDS_PER_MSG = 10;
const MAX_RETRIES = 3;

const REGION_MAP = {
  // 関東
  '東京都': 'KANTO', '神奈川県': 'KANTO', '埼玉県': 'KANTO', '千葉県': 'KANTO',
  '茨城県': 'KANTO', '栃木県': 'KANTO', '群馬県': 'KANTO', '山梨県': 'KANTO',

  // 関西
  '大阪府': 'KANSAI', '兵庫県': 'KANSAI', '京都府': 'KANSAI', '滋賀県': 'KANSAI',
  '奈良県': 'KANSAI', '和歌山県': 'KANSAI',

  // 中部東海
  '愛知県': 'CHUBU', '静岡県': 'CHUBU', '岐阜県': 'CHUBU', '三重県': 'CHUBU',

  // 北陸甲信越
  '新潟県': 'HOKURIKU', '長野県': 'HOKURIKU', '富山県': 'HOKURIKU', '石川県': 'HOKURIKU', '福井県': 'HOKURIKU',

  // 北海道東北
  '北海道': 'TOHOKU', '青森県': 'TOHOKU', '岩手県': 'TOHOKU', '宮城県': 'TOHOKU',
  '秋田県': 'TOHOKU', '山形県': 'TOHOKU', '福島県': 'TOHOKU',

  // 中国四国
  '鳥取県': 'CHUSHIKOKU', '島根県': 'CHUSHIKOKU', '岡山県': 'CHUSHIKOKU', '広島県': 'CHUSHIKOKU',
  '山口県': 'CHUSHIKOKU', '徳島県': 'CHUSHIKOKU', '香川県': 'CHUSHIKOKU', '愛媛県': 'CHUSHIKOKU', '高知県': 'CHUSHIKOKU',

  // 九州沖縄
  '福岡県': 'KYUSHU', '佐賀県': 'KYUSHU', '長崎県': 'KYUSHU', '熊本県': 'KYUSHU',
  '大分県': 'KYUSHU', '宮崎県': 'KYUSHU', '鹿児島県': 'KYUSHU', '沖縄県': 'KYUSHU'
};

const REGION_WEBHOOK_ENVS = {
  KANTO: 'DISCORD_WEBHOOK_KANTO',
  KANSAI: 'DISCORD_WEBHOOK_KANSAI',
  CHUBU: 'DISCORD_WEBHOOK_CHUBU',
  HOKURIKU: 'DISCORD_WEBHOOK_HOKURIKU',
  TOHOKU: 'DISCORD_WEBHOOK_TOHOKU',
  CHUSHIKOKU: 'DISCORD_WEBHOOK_CHUSHIKOKU',
  KYUSHU: 'DISCORD_WEBHOOK_KYUSHU'
};

/**
  * Resolves regional webhook URL or falls back to default
  */
function getWebhookUrlForEvent(event, defaultWebhookUrl) {
  const pref = event.prefecture_name || '';
  const regionKey = REGION_MAP[pref];
  if (regionKey && REGION_WEBHOOK_ENVS[regionKey]) {
    const envName = REGION_WEBHOOK_ENVS[regionKey];
    if (process.env[envName]) {
      return process.env[envName];
    }
  }
  return defaultWebhookUrl;
}

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
 * Builds a beautiful Discord Rich Embed card for a tournament event
 */
function buildEventEmbed(event, categoryLabel) {
  const title = event.event_title || '（無題の大会）';
  const pref = event.prefecture_name || '';
  const league = event.leagueName || '';
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
  const isCityLeague = (categoryLabel && categoryLabel.includes('シティ')) || (event.event_type === 2);

  // Gold (#FFA500 = 16753920) for City League, DodgerBlue (#1E90FF = 2003199) for Other Events
  const color = isCityLeague ? 16753920 : 2003199;
  const icon = isCityLeague ? '🏆【シティリーグ】' : '⚔️【その他大会】';

  return {
    title: `${icon} ${shop} (${pref || '全国'})`,
    url: url || undefined,
    color,
    fields: [
      { name: '🏆 大会名', value: title, inline: false },
      { name: '📍 都道府県 / リーグ', value: `${pref || '全国'} / ${league || '全般'}`, inline: true },
      { name: '📅 開催日時', value: fullDateTime || '日時未定', inline: true },
      { name: 'ℹ️ 募集詳細', value: metaLine || '詳細なし', inline: false }
    ],
    footer: {
      text: 'ポケカ大会 募集・空き枠リアルタイム通知 | pokemimi.com'
    }
  };
}

/**
 * Posts payload object (content / embeds) to Discord Webhook with 429 Retry handling
 */
async function postDiscordWebhook(webhookUrl, payloadObj) {
  const isDryRun = process.env.PM_NOTIFY_DRYRUN === 'true';

  if (isDryRun || !webhookUrl) {
    logger.info(`[DRY-RUN / NO-WEBHOOK] Discord Payload:\n${JSON.stringify(payloadObj, null, 2)}`);
    return true;
  }

  let attempt = 0;
  let delay = 1000;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      await axios.post(webhookUrl, payloadObj, { timeout: 10000 });
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
 * Groups events by regional Discord Webhook and posts Rich Card Embeds
 */
async function sendEventNotifications(defaultWebhookUrl, categoryLabel, headerMessage, events) {
  if (!events || events.length === 0) return;

  // Group events by target regional webhook URL
  const groupedByWebhook = {};
  for (const event of events) {
    const webhookUrl = getWebhookUrlForEvent(event, defaultWebhookUrl);
    if (!webhookUrl) continue;
    if (!groupedByWebhook[webhookUrl]) {
      groupedByWebhook[webhookUrl] = [];
    }
    groupedByWebhook[webhookUrl].push(event);
  }

  for (const [targetUrl, regionEvents] of Object.entries(groupedByWebhook)) {
    const embeds = regionEvents.map(e => buildEventEmbed(e, categoryLabel));

    // Send in batches of 10 embeds per Discord webhook call
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MSG) {
      const embedBatch = embeds.slice(i, i + MAX_EMBEDS_PER_MSG);
      const isFirst = (i === 0);
      const payloadObj = {
        content: isFirst ? headerMessage : undefined,
        embeds: embedBatch
      };

      logger.info(`Sending ${embedBatch.length} Rich Embed card(s) for ${categoryLabel} to Webhook (${targetUrl.slice(0, 45)}...)...`);
      await postDiscordWebhook(targetUrl, payloadObj);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

module.exports = {
  buildEventDetailUrl,
  buildEventEmbed,
  sendEventNotifications,
  postDiscordWebhook
};
