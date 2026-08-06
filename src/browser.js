const { chromium } = require('playwright');
const logger = require('./logger');

const BASE_URL = 'https://players.pokemon-card.com/';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

let globalBrowser = null;
let globalContext = null;
let globalPage = null;

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

  logger.info(`Navigating to ${BASE_URL} to pass Cloudflare challenge...`);
  try {
    await globalPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await globalPage.waitForTimeout(3000); // Allow JS challenge execution
    logger.info(`Cloudflare session established. Page title: "${await globalPage.title()}"`);
  } catch (err) {
    logger.warn(`Initial navigation warning: ${err.message}`);
  }

  return { browser: globalBrowser, context: globalContext, page: globalPage };
}

/**
 * Executes a fetch request inside the authenticated browser context to bypass Cloudflare 403.
 */
async function fetchJsonInBrowser(url, options = {}) {
  const { page } = await initBrowserSession();

  const result = await page.evaluate(async ({ fetchUrl, fetchOptions }) => {
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

  if (result.status === 404) {
    return { status: 404, data: null };
  }

  if (result.error) {
    throw new Error(`Fetch failed (${url}): ${result.error}`);
  }

  return { status: result.status, data: result.data };
}

/**
 * Fetches HTML content inside the authenticated browser context.
 */
async function fetchHtmlInBrowser(url) {
  const { page } = await initBrowserSession();

  const result = await page.evaluate(async (targetUrl) => {
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) return { status: res.status, html: null };
      const html = await res.text();
      return { status: res.status, html };
    } catch (e) {
      return { status: 0, error: e.message };
    }
  }, url);

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
  initBrowserSession,
  fetchJsonInBrowser,
  fetchHtmlInBrowser,
  closeBrowserSession
};
