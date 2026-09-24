/**
 * 取り込み本体を **実際に動かして** みる（通信は偽物・本番の state は触らない）。
 *
 * 🚨 なぜ要るか（2026-09-24）:
 *   `node --check` は構文しか見ない。変数の宣言を使う場所より後ろに置いてしまい、
 *   本番で "Cannot access 'cyclePages' before initialization" が出て **3リーグとも落ちた**のに、
 *   リーグごとに catch していたのでワークフローは**緑**だった（偽の緑）。
 *   一度でも動かしていれば、その場で判ったもの。
 *
 * 使い方: node test/rank_run_smoke.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const TOTAL_PAGES = { master: 243, senior: 42, junior: 29 };
const PAGE_SIZE = 20;
let fetched = [];

/* 通信を偽物に差し替える（本物の playwright / DB は使わない） */
function stub(modPath, exports) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}
stub('../src/browser', {
  async fetchJsonInBrowser(url) {
    const league = /league=(\w+)/.exec(url)[1];
    const pageNo = Number(/pageNo=(\d+)/.exec(url)[1]);
    fetched.push(`${league}:${pageNo}`);
    const total = TOTAL_PAGES[league];
    if (pageNo > total) return { status: 200, data: { count: total, result: [] } };
    const result = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: pageNo * 100 + i, playerId: String(pageNo * 100 + i).padStart(10, '0'),
      nickname: 'x', currentLeagueId: 4, currentRanking: 1,
      prefectureName: '愛知県', championShipPoint: 30, publicFlg: 0, championFlg: 0, avatarImage: null
    }));
    return { status: 200, data: { count: total, result } };
  },
  closeBrowserSession: async () => {}
});
const posted = [];
stub('../src/db', {
  async postApiSync(action, payload) {
    posted.push({ league: payload.league, n: payload.players.length, is_end: payload.is_end });
    return { affected: payload.players.length, dropped: 0 };
  },
  closePool: async () => {}
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-smoke-'));
process.env.PLAYER_RANK_STATE_FILE = path.join(tmp, 'state.json');
const { runPlayerRankTask } = require('../src/tasks/player_rank');
const { PAGES_PER_RUN } = require('../src/rank_rules');

(async () => {
  let ng = 0;
  const check = (label, fn) => { try { fn(); console.log('✅ ' + label); } catch (e) { ng++; console.error('❌ ' + label + ' — ' + e.message); } };

  /* 1回目 */
  await runPlayerRankTask();
  const run1 = fetched.filter((x) => x.startsWith('master:')).length;
  check('1回目で master を上限ぶん読む', () => assert.strictEqual(run1, PAGES_PER_RUN));
  check('1回目はまだ「読み切った」と言わない', () =>
    assert.ok(!posted.some((p) => p.league === 'master' && p.is_end), 'is_end を送ってはいけない'));
  check('senior/junior は1回で読み切る', () => {
    assert.strictEqual(fetched.filter((x) => x.startsWith('senior:')).length, 42);
    assert.strictEqual(fetched.filter((x) => x.startsWith('junior:')).length, 29);
    assert.ok(posted.some((p) => p.league === 'senior' && p.is_end), 'senior は is_end を送る');
  });

  /* 2回目・3回目 — 続きから読む */
  fetched = [];
  await runPlayerRankTask();
  check('2回目は続きのページから読む', () => assert.strictEqual(fetched[0], 'master:121'));

  fetched = [];
  posted.length = 0;
  await runPlayerRankTask();
  check('3回目で master を読み切り、is_end を送る', () => {
    assert.ok(fetched.includes('master:243'), '243ページ目まで読む');
    assert.ok(posted.some((p) => p.league === 'master' && p.is_end), 'is_end を送る');
  });

  const state = JSON.parse(fs.readFileSync(process.env.PLAYER_RANK_STATE_FILE, 'utf8'));
  check('読み切ったらサイクルが畳まれる', () => {
    assert.strictEqual(state.master.offset, 0);
    assert.strictEqual(state.master.cycle_started_at, null);
    assert.strictEqual(state.master.last_cycle_total, 243 * PAGE_SIZE);   /* 4,860人 */
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (ng) { console.error(`\n❌ ${ng} 件。`); process.exit(1); }
  console.log('\n✅ 3回で master 243ページ 4,860人を読み切り、途中では終わりと言わない');
})();
