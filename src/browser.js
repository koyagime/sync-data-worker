const { chromium } = require('playwright');
const logger = require('./logger');

const BASE_URL = 'https://players.pokemon-card.com/';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

let globalBrowser = null;
let globalContext = null;
let globalPage = null;

/**
 * Cloudflare's JS challenge takes a variable amount of time to clear.
 *
 * The previous code waited a flat 3 seconds and then logged "session established"
 * unconditionally -- so whenever the challenge ran long we carried on WITHOUT the
 * clearance cookie and every later fetch died with HTTP 403. That killed the whole
 * task (exit 1) in ~20% of runs on 2026-08-09.
 *
 * Wait until the interstitial actually goes away instead of guessing. Polling the
 * title is free: it costs no extra requests to the origin.
 */
const CF_INTERSTITIAL = /just a moment|attention required|checking your browser|cloudflare/i;

async function establishCloudflareSession(page) {
  logger.info(`Navigating to ${BASE_URL} to pass Cloudflare challenge...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      logger.warn(`Navigation warning (attempt ${attempt}/3): ${err.message}`);
    }

    for (let waited = 0; waited < 30000; waited += 2000) {
      await page.waitForTimeout(2000);
      let title = '';
      try {
        title = await page.title();
      } catch (e) {
        continue; // navigating -- look again on the next tick
      }
      if (title && !CF_INTERSTITIAL.test(title)) {
        logger.info(`Cloudflare session established. Page title: "${title}"`);
        return true;
      }
    }
    logger.warn(`Cloudflare challenge still showing after 30s (attempt ${attempt}/3).`);
  }

  logger.warn('Cloudflare の関門を抜けられませんでした。この回は取りに行きません（次の回で拾い直します）');
  return false;
}

/**
 * 🚨 2026-09-28: 関門を抜けられないまま取りに行くと、
 *    「403 → その場で関門をやり直す → また403」を1リクエストごとに繰り返していた。
 *    こちらから押し返しているのと同じで、向こうを刺激するし時間も食う
 *    （実測 9/25〜9/27 は info の所要が90%点で 195→217→231秒 まで伸びた）。
 *    → 抜けられなかった回は**取りに行かずに諦める**。取り残しは次の回が拾う。
 */
function upstreamBusyError(url) {
  const err = new Error(`Cloudflare の関門を抜けられませんでした (${url})`);
  err.pmTransient = true;
  err.pmUpstream = true;
  err.pmBusy = true;
  return err;
}

async function initBrowserSession() {
  if (globalPage && !globalPage.isClosed()) {
    return { browser: globalBrowser, context: globalContext, page: globalPage };
  }

  const isHeadless = process.env.HEADLESS !== 'false';
  logger.info(`Launching Chromium (headless: ${isHeadless})...`);

  globalBrowser = await chromium.launch({
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  globalContext = await globalBrowser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });

  globalPage = await globalContext.newPage();

  await establishCloudflareSession(globalPage);

  return { browser: globalBrowser, context: globalContext, page: globalPage };
}

/**
 * Executes a fetch request inside the authenticated browser context to bypass Cloudflare 403.
 */
async function evalJsonFetch(page, url, options) {
  return page.evaluate(async ({ fetchUrl, fetchOptions }) => {
    try {
      const response = await fetch(fetchUrl, {
        method: fetchOptions.method || 'GET',
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          ...(fetchOptions.headers || {})
        }
      });

      if (response.status === 404) {
        return { status: 404, data: null };
      }

      if (!response.ok) {
        return { status: response.status, error: `HTTP ${response.status} ${response.statusText}` };
      }

      const text = await response.text();
      try {
        const json = JSON.parse(text);
        return { status: response.status, data: json };
      } catch (e) {
        return { status: response.status, error: `JSON Parse error: ${e.message}`, rawSnippet: text.substring(0, 200) };
      }
    } catch (err) {
      return { status: 0, error: err.message };
    }
  }, { fetchUrl: url, fetchOptions: options });
}

/* この実行で関門を抜けられなかったと判ったら、以降は取りに行かない（1回だけ諦める判断をする） */
let sessionGivenUp = false;
function resetSessionGivenUp() { sessionGivenUp = false; }

async function fetchJsonInBrowser(url, options = {}) {
  if (sessionGivenUp) throw upstreamBusyError(url);

  const { page } = await initBrowserSession();

  let result = await evalJsonFetch(page, url, options);

  /* 403 は「データが無い」ではなく「通行証が無い/切れた」。1度だけ関門をやり直して取り直す。
     ⚠ やり直しても駄目なら**この実行は終わり**にする（2026-09-28）。
        以前は1リクエストごとに無限にやり直していて、押し返しになっていた。 */
  if (result.status === 403) {
    logger.warn(`HTTP 403 from ${url} -- 関門をやり直して1回だけ取り直します`);
    const ok = await establishCloudflareSession(page);
    if (!ok) { sessionGivenUp = true; throw upstreamBusyError(url); }
    result = await evalJsonFetch(page, url, options);
    if (result.status === 403) {
      logger.warn('関門をやり直しても403でした。この実行はここで諦めます（次の回で拾い直します）');
      sessionGivenUp = true;
      throw upstreamBusyError(url);
    }
  }

  if (result.status === 404) {
    return { status: 404, data: null };
  }

  if (result.error) {
    /* 🚩 2026-09-24: ここに印が無かったので、**公式サイト側の403が毎回メールになっていた**。
       印の意味は db.js/index.js と同じ「次の回で拾い直せる失敗」。
       公式は Cloudflare で守られていて、関門を抜けられない回・抜けたのに403が返る回がある。
       未処理ぶんはサーバ側に残り次の回が拾い直すので、1回ごとにメールを出す意味が無い。
       ⚠ 黙らせっぱなしにはしない。index.js が **連続で失敗した回数**を数えていて、
          続くようなら（＝自力で治っていない）そこで落としてメールを出す。 */
    const err = new Error(`Fetch failed (${url}): ${result.error}`);
    err.pmTransient = true;
    err.pmUpstream = true;
    err.pmStatus = result.status;
    throw err;
  }

  return { status: result.status, data: result.data };
}

/**
 * Fetches HTML content inside the authenticated browser context.
 */
async function evalHtmlFetch(page, url) {
  return page.evaluate(async (targetUrl) => {
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) return { status: res.status, html: null };
      const html = await res.text();
      return { status: res.status, html };
    } catch (e) {
      return { status: 0, error: e.message };
    }
  }, url);
}

async function fetchHtmlInBrowser(url) {
  const { page } = await initBrowserSession();

  let result = await evalHtmlFetch(page, url);

  if (result.status === 403) {
    logger.warn(`HTTP 403 from ${url} -- re-running the Cloudflare challenge, then retrying once.`);
    await establishCloudflareSession(page);
    result = await evalHtmlFetch(page, url);
  }

  if (!result.html) {
    throw new Error(`HTML fetch failed (${url}): HTTP ${result.status}`);
  }

  return result.html;
}

async function closeBrowserSession() {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
    } catch (e) {
      // ignore
    }
    globalBrowser = null;
    globalContext = null;
    globalPage = null;
  }
}

module.exports = {
  resetSessionGivenUp,
  initBrowserSession,
  fetchJsonInBrowser,
  fetchHtmlInBrowser,
  closeBrowserSession
};
