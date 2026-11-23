/**
 * 公式を「読めた」と言ってよいかの判定と、生きている印の渡し方を確かめる（通信は偽物・本番の state は触らない）。
 *
 * 🚨 なぜ要るか（2026-11-23）:
 *   11/21 10:42Z ごろから、最初の頁の題名が確かめの画面「しばらくお待ちください...」のまま進み、
 *   記録は毎回「Fetched 0 active events」「受付中 0 / 受付終了 0 のまま」で**成功**だった。
 *   「本当に0件」と「公式に入れず0件」が同じ形をしていて、止まっても誰も気づけない。
 *   → 成立（読めた・本当に0件も読めたうち）と不成立（入れない・形が違う）の**両方**を固定する。
 *
 * 返事の形は 2026-11-23 に本物のブラウザで公式を叩いて確かめた実物に合わせている:
 *   大会がある 200 {"code":200,"event":[…],"eventCount":696} / 0件 404 {"code":404,"message":"イベント情報が存在しません。"}
 *   絞り込み無しの総数（受付終了を含む）200 eventCount=9515
 *
 * 使い方: node test/read_check.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

function stub(modPath, exports) {
  const r = require.resolve(modPath);
  require.cache[r] = { id: r, filename: r, loaded: true, exports, children: [], paths: [] };
}

/* 偽の公式。handler(url) を差し替えて場面を作る */
let handler = () => { throw new Error('handler 未設定'); };
let fetched = [];
let title = 'イベント | ポケモンカードゲーム プレイヤーズクラブ';
stub('../src/browser', {
  async fetchJsonInBrowser(url) { fetched.push(url); return handler(url); },
  async fetchHtmlInBrowser() { throw new Error('この試験ではデッキの頁は取らない'); },
  getSessionInfo: () => ({ title, cleared: true }),
  closeBrowserSession: async () => {}
});
/* ⚠ 計器の中の本体ログは黙らせる（CI の記録を本番の実行と見分けられなくなる・2026-09-28） */
stub('../src/logger', { info() {}, warn() {}, error() {}, debug() {} });
stub('../src/db', {
  async postApiSync(action, payload) {
    if (action === 'rank') return { affected: payload.players.length, dropped: 0 };
    return { status: 'ok' };
  },
  async fetchBacklog() { return null; },
  getPool: () => null, closePool: async () => {}
});
stub('../src/discord', { async sendEventNotifications() {} });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-check-'));
process.env.TOURNAMENT_INFO_STATE_FILE = path.join(tmp, 'info.json');
process.env.PLAYER_RANK_STATE_FILE = path.join(tmp, 'rank.json');
process.env.RESUME_SILENT_AFTER_SECONDS = '999999999';
delete process.env.PUSH_NOTIFY_KEY;   /* アプリへの通知を本当に投げない */

const U = require('../src/upstream_check');
const { runTournamentInfoTask } = require('../src/tasks/tournament_info');
const { runTournamentResultTask } = require('../src/tasks/tournament_result');
const { runPlayerRankTask } = require('../src/tasks/player_rank');
const { sendHeartbeat, settleRead, DEFAULT_URL } = require('../src/heartbeat');

/* 実物の形 */
const EMPTY = { status: 404, data: { code: 404, message: 'イベント情報が存在しません。' } };
const COUNT = (n, rows = 1) => ({ status: 200, data: { code: 200, eventCount: n, event: Array.from({ length: rows }, (_, i) => ({ id: i + 1, date_id: 9000 + i, event_date_params: '20261205' })) } });
const isTotal = (url) => !/event_type/.test(url);

let ng = 0, pass = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log('✅ ' + label); } catch (e) { ng++; console.error('❌ ' + label + ' — ' + e.message); }
};
const resetInfoState = () => { try { fs.unlinkSync(process.env.TOURNAMENT_INFO_STATE_FILE); } catch (e) { /* 無ければよい */ } };

(async () => {
  /* ── 判定だけ（通信なし） ───────────────────────────── */
  await check('確かめの画面の題名（日本語）を「抜けていない」と見る', () => {
    assert.ok(U.CF_INTERSTITIAL.test('しばらくお待ちください...'), '11/21 から出ている日本語の題名を見逃している');
    assert.ok(U.CF_INTERSTITIAL.test('Just a moment...'));
    assert.ok(!U.CF_INTERSTITIAL.test('イベント | ポケモンカードゲーム プレイヤーズクラブ'), '公式の本物の題名を確かめの画面と取り違えた');
  });
  await check('0件は「公式の 404 の JSON」のときだけ 0。本文の無い 404 は読めていない（null）', () => {
    assert.strictEqual(U.readEventCount(EMPTY), 0);
    assert.strictEqual(U.readEventCount({ status: 404, data: null }), null);
    assert.strictEqual(U.readEventCount(COUNT(696)), 696);
    assert.strictEqual(U.readEventCount({ status: 200, data: '<html>' }), null);
    assert.strictEqual(U.readEventCount({ status: 200, data: { code: 200, event: [] } }), null, '総数の無い返事を数にした');
  });
  await check('公式の総数（受付終了を含む）: 数が読めて1以上なら読めた／0・404・形ちがいは読めていない', () => {
    assert.deepStrictEqual(U.readOfficialTotal(COUNT(9515)), { ok: true, total: 9515, reason: '' });
    assert.ok(!U.readOfficialTotal(COUNT(0, 0)).ok, '全国の全大会0件を「読めた」にした');
    assert.ok(!U.readOfficialTotal(EMPTY).ok);
    assert.ok(!U.readOfficialTotal({ status: 200, data: null }).ok);
  });
  await check('結果の一覧: 200 の配列と 0件の 404 は読めた／中身の無い返事は読めていない', () => {
    assert.ok(U.readResultFeed(COUNT(25, 3)).ok);
    assert.strictEqual(U.readResultFeed(COUNT(25, 3)).total, 25);
    assert.ok(U.readResultFeed(EMPTY).ok);
    assert.ok(!U.readResultFeed({ status: 404, data: null }).ok);
    assert.ok(!U.readResultFeed({ status: 200, data: { code: 200 } }).ok);
  });
  await check('ランキングの頁: 選手あり=page／404・空=end／形ちがい=bad', () => {
    assert.strictEqual(U.classifyRankPage({ status: 200, data: { count: 3, result: [{}] } }), 'page');
    assert.strictEqual(U.classifyRankPage({ status: 200, data: { count: 3, result: [] } }), 'end');
    assert.strictEqual(U.classifyRankPage({ status: 404, data: null }), 'end');
    assert.strictEqual(U.classifyRankPage({ status: 200, data: null }), 'bad');
    assert.strictEqual(U.classifyRankPage({ status: 200, data: { message: 'x' } }), 'bad');
  });

  /* ── 大会情報の本体を動かす ─────────────────────────── */
  resetInfoState(); fetched = [];
  handler = (url) => (isTotal(url) ? COUNT(9515) : EMPTY);   /* 公式には入れた。受付中は本当に0件 */
  let r = await runTournamentInfoTask();
  await check('成立: 受付中が本当に0件でも、総数が読めていれば「読めた」', () => {
    assert.strictEqual(r.readOk, true, r.reason);
    assert.strictEqual(r.total, 9515);
    assert.ok(/全大会 9515件/.test(r.detail), r.detail);
  });

  resetInfoState(); fetched = [];
  title = 'しばらくお待ちください...';
  handler = () => ({ status: 404, data: null });               /* 11/21〜 の形: 確かめの画面のまま、本文の無い返事 */
  r = await runTournamentInfoTask();
  await check('不成立: 確かめの画面のまま・本文の無い 404 は「読めなかった」（以前は成功だった）', () => {
    assert.strictEqual(r.readOk, false);
    assert.ok(/総数が数として読めなかった/.test(r.reason), r.reason);
    assert.strictEqual(r.title, 'しばらくお待ちください...', '題名を持ち帰っていない');
  });
  await check('不成立のときは大会の一覧を取りに行かない（押し返さない）', () =>
    assert.deepStrictEqual(fetched.filter((u) => !isTotal(u)), [], `取りに行った: ${fetched}`));
  title = 'イベント | ポケモンカードゲーム プレイヤーズクラブ';

  resetInfoState(); fetched = [];
  handler = () => { const e = new Error('Cloudflare の関門を抜けられませんでした'); e.pmTransient = true; e.pmUpstream = true; throw e; };
  r = await runTournamentInfoTask();
  await check('不成立: 関門で弾かれた（例外）も「読めなかった」で返す（落ちずに理由を持ち帰る）', () => {
    assert.strictEqual(r.readOk, false);
    assert.ok(/関門/.test(r.reason), r.reason);
  });

  resetInfoState(); fetched = [];
  handler = (url) => (isTotal(url) ? COUNT(9515) : (/3%3A2/.test(url) ? { status: 200, data: { code: 200 } } : EMPTY));
  r = await runTournamentInfoTask();
  await check('不成立: 総数は読めても、一覧の返事の形が違えば「読めなかった」（どの大会か理由に出す）', () => {
    assert.strictEqual(r.readOk, false);
    assert.ok(/シティリーグ/.test(r.reason), r.reason);
  });

  /* ── 大会結果の本体 ─────────────────────────────────── */
  handler = () => ({ status: 404, data: null });
  let rr = await runTournamentResultTask();
  await check('結果 不成立: 本文の無い 404 は「一覧が取れなかった」（以前は0件で成功）', () => {
    assert.strictEqual(rr.feedFailed, true);
    assert.ok(/形が違う/.test(rr.feedReason), rr.feedReason);
  });
  handler = () => EMPTY;
  rr = await runTournamentResultTask();
  await check('結果 成立: 公式の 0件の返事は「読めた・0件」', () => {
    assert.strictEqual(rr.feedFailed, false);
    assert.strictEqual(rr.feedTotal, 0);
  });

  /* ── ランキングの本体 ───────────────────────────────── */
  handler = () => ({ status: 200, data: null });
  let threw = null;
  try { await runPlayerRankTask(); } catch (e) { threw = e; }
  await check('ランク 不成立: 全リーグで返事の形が違えば落とす側に回す（公式側の失敗の印つき）', () => {
    assert.ok(threw, '形が違うのに「終わり」とみなして黙って終わった');
    assert.ok(threw.pmTransient && threw.pmUpstream, '公式側の失敗の印が無い');
  });
  try { fs.unlinkSync(process.env.PLAYER_RANK_STATE_FILE); } catch (e) { /* 無ければよい */ }
  handler = () => ({ status: 404, data: null });
  let rk = await runPlayerRankTask();
  await check('ランク 不成立: 1ページも読めなければ「読めた」と言わない', () => assert.strictEqual(rk.readOk, false));
  try { fs.unlinkSync(process.env.PLAYER_RANK_STATE_FILE); } catch (e) { /* 無ければよい */ }
  handler = (url) => {
    const pageNo = Number(/pageNo=(\d+)/.exec(url)[1]);
    if (pageNo > 2) return { status: 200, data: { count: 2, result: [] } };
    return { status: 200, data: { count: 2, result: Array.from({ length: 20 }, (_, i) => ({ playerId: String(pageNo * 100 + i), nickname: 'x', prefectureName: '愛知県' })) } };
  };
  rk = await runPlayerRankTask();
  await check('ランク 成立: ページが読めたら「読めた」・読んだページ数を返す', () => {
    assert.strictEqual(rk.readOk, true, rk.reason);
    assert.strictEqual(rk.total, 6, `3リーグ×2ページのはず: ${rk.total}`);
  });

  /* ── 生きている印 ───────────────────────────────────── */
  let posts = [];
  const post = async (url, body) => { posts.push({ url, body }); return { ok: true }; };
  let h = await sendHeartbeat('info', { ok: true, total: 9515 }, { env: {}, post });
  await check('印: 合言葉が無ければ送らない（取り込みは止めない）', () => {
    assert.strictEqual(posts.length, 0); assert.strictEqual(h.skipped, 'no_key');
  });
  h = await sendHeartbeat('info', { ok: true, total: 9515, detail: 'x'.repeat(500), title: 't' }, { env: { PUSH_NOTIFY_KEY: ' k\n' }, post });
  await check('印: 形（合言葉は前後の空白を落とす・既定の送り先・長い説明は切る）', () => {
    assert.strictEqual(posts[0].url, DEFAULT_URL);
    assert.strictEqual(posts[0].body.key, 'k');
    assert.strictEqual(posts[0].body.task, 'info');
    assert.strictEqual(posts[0].body.ok, true);
    assert.strictEqual(posts[0].body.total, 9515);
    assert.strictEqual(posts[0].body.detail.length, 300);
  });
  h = await sendHeartbeat('info', { ok: true }, { env: { PUSH_NOTIFY_KEY: 'k' }, post: async () => { const e = new Error('down'); e.response = { status: 503, headers: {} }; throw e; } });
  await check('印: 送り先が落ちても例外を投げない', () => assert.strictEqual(h.sent, false));
  posts = [];
  h = await sendHeartbeat('deck', { ok: true }, { env: { PUSH_NOTIFY_KEY: 'k' }, post });
  await check('印: 知らない仕事の名前は送らない', () => assert.strictEqual(posts.length, 0));

  /* settleRead: 読めた/読めないを数取り器と印に渡す */
  const calls = [];
  const sent = [];
  const hooks = (failReturns) => ({
    onOk: (t) => calls.push(['ok', t]),
    onFail: (t, why) => { calls.push(['fail', t, why]); return failReturns; },
    send: async (t, b) => { sent.push([t, b]); return { sent: true }; }
  });
  let s = await settleRead('info', { readOk: true, total: 9515, detail: 'd' }, hooks(false));
  await check('仕上げ 成立: 数取り器を戻し、印は ok:true と総数', () => {
    assert.deepStrictEqual(calls.pop(), ['ok', 'info']);
    assert.strictEqual(sent[0][1].ok, true); assert.strictEqual(sent[0][1].total, 9515);
    assert.strictEqual(s.fail, false);
  });
  s = await settleRead('info', { readOk: false, reason: '総数が読めなかった' }, hooks(false));
  await check('仕上げ 不成立（1回目）: 数えて印は ok:false。まだ落とさない', () => {
    const c = calls.pop(); assert.strictEqual(c[0], 'fail'); assert.ok(/総数/.test(c[2]));
    assert.strictEqual(sent[1][1].ok, false);
    assert.strictEqual(s.fail, false);
  });
  s = await settleRead('info', { readOk: false, reason: 'x' }, hooks(true));
  await check('仕上げ 不成立（続いた）: 数取り器が「落とす」と言ったら落とす（終了コード 1）', () => assert.strictEqual(s.fail, true));

  fs.rmSync(tmp, { recursive: true, force: true });
  if (ng) { console.error(`\n❌ ${ng} 件（通った ${pass} 件）`); process.exit(1); }
  console.log(`\n✅ ${pass} 件。「本当に0件」は読めた、「入れず0件」「形ちがい」は読めなかった、と分けられる`);
})().catch((e) => { console.error('❌ 試験そのものが落ちた:', e.stack || e.message); process.exit(1); });
