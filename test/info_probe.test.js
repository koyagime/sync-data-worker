/**
 * 通知のたびに全件を取り直さない仕組みを、本体を動かして確かめる（通信は偽物）。
 *
 * 🚨 なぜ要るか（2026-09-28）:
 *   目的は「募集開始・空き枠が出た」ことを**すぐ**知らせること。
 *   それなのに5分おきに毎回16ページ（シティリーグ3＋その他大会13）取り直していた＝約4,600ページ/日。
 *   → まず総数だけ聞いて、動いたときだけ全件を見る。
 *   ⚠ ここが壊れると「通知が来ない」という一番まずい壊れ方をするので、
 *     **増えたときに必ず全件へ行く**ことを固定する。
 *
 * 使い方: node test/info_probe.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

let counts = { '3:2': { t: 55, f: 566 }, '3:7': { t: 257, f: 900 } };
let pages = [];        /* 全件取得で叩いたページ */
let probes = [];       /* 総数だけ聞いた回数 */
const notified = [];

function stub(modPath, exports) {
  const r = require.resolve(modPath);
  require.cache[r] = { id: r, filename: r, loaded: true, exports, children: [], paths: [] };
}
stub('../src/browser', {
  async fetchJsonInBrowser(url) {
    const type = /event_type%5B%5D=(3%3A\d)/.exec(url)[1].replace('%3A', ':');
    const accepting = /accepting=(\w+)/.exec(url)[1];
    const offset = Number(/offset=(\d+)/.exec(url)[1]);
    const total = accepting === 'true' ? counts[type].t : counts[type].f;
    if (offset === 0) probes.push(`${type}:${accepting}`);
    else pages.push(`${type}:${accepting}:${offset}`);
    if (offset >= total) return { status: 404, data: null };
    const n = Math.min(20, total - offset);
    const event = Array.from({ length: n }, (_, i) => ({ id: 1, date_id: offset + i, event_date_params: '20261001' }));
    return { status: 200, data: { eventCount: total, event } };
  },
  closeBrowserSession: async () => {}
});
/* ⚠ 本体の logger をそのまま鳴らすと、CI のログが**本番の実行と見分けられなくなる**。
   2026-09-28 に実際に取り違えて「総数が持ち越せていない」と誤診した（計器の出力を本番と読んだ）。
   → 計器の中の本体ログは黙らせる（失敗は assert が出す）。 */
stub('../src/logger', { info() {}, warn() {}, error() {}, debug() {} });
let freedToReturn = [];   /* 受け口が「満席が解けた」と答える分 */
stub('../src/db', {
  async postApiSync(action, payload) {
    if (action === 'info' && payload.is_active && freedToReturn.length) {
      const out = freedToReturn; freedToReturn = []; return { freed: out };
    }
    return {};
  },
  getPool: () => null, closePool: async () => {}
});
stub('../src/discord', { async sendEventNotifications(_u, label, _h, events) { notified.push({ label, n: events.length }); } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'info-probe-'));
process.env.TOURNAMENT_INFO_STATE_FILE = path.join(tmp, 'state.json');
process.env.DISCORD_CITY_WEBHOOK = 'https://example.invalid/hook';
process.env.DISCORD_OTHER_WEBHOOK = 'https://example.invalid/hook';
process.env.RESUME_SILENT_AFTER_SECONDS = '999999999';   /* 沈黙モードに入らせない */
const { runTournamentInfoTask, decideFullScan } = require('../src/tasks/tournament_info');

const reset = () => { pages = []; probes = []; notified.length = 0; };
let ng = 0;
const check = (label, fn) => { try { fn(); console.log('✅ ' + label); } catch (e) { ng++; console.error('❌ ' + label + ' — ' + e.message); } };

(async () => {
  /* ── 判断だけの確認（通信なし） ───────────────────── */
  const P = { t: 55, f: 566 };
  check('前回の総数が無ければ全件', () => assert.ok(decideFullScan(null, P, 0, false).need));
  check('受付中が増えたら全件（通知が要る）', () => assert.ok(decideFullScan({ t: 54, f: 566 }, P, 0, false).need));
  check('受付中が減っても全件（数を合わせ直す）', () => assert.ok(decideFullScan({ t: 56, f: 566 }, P, 0, false).need));
  check('受付終了が増えたら全件（入れ替わりが隠れる）', () => assert.ok(decideFullScan({ t: 55, f: 565 }, P, 0, false).need));
  check('総数が読めなければ全件', () => assert.ok(decideFullScan(P, { t: null, f: 566 }, 0, false).need));
  check('何も動いていなければ全件に行かない', () => assert.ok(!decideFullScan(P, P, 60, false).need));
  check('動いていなくても30分たてば全件', () => assert.ok(decideFullScan(P, P, 1800, false).need));

  /* ── 本体を動かす ──────────────────────────────── */
  reset();
  await runTournamentInfoTask();                 /* 1回目: 前回の数が無いので全件 */
  check('1回目は全件を取る', () => assert.ok(pages.length > 10, `ページ ${pages.length}`));

  reset();
  await runTournamentInfoTask();                 /* 2回目: 何も動いていない */
  check('その他大会は総数だけ（全件に行かない）', () =>
    assert.ok(!pages.some((p) => p.startsWith('3:7')), `その他大会の全件を取っている: ${pages}`));
  /* ⚠ シティリーグだけは毎回まるごと見る。受付中の一覧に満席の大会が居座るので、
     総数だけ見ていると「満席が解けた」に気づけないため（2026-10-20）。 */
  check('シティリーグは動いていなくても毎回見る', () =>
    assert.ok(probes.includes('3:2:true'), 'シティリーグの受付中を取りに行っていない'));
  check('シティリーグの総数問い合わせ（受付終了側）はしない', () =>
    assert.ok(!probes.includes('3:2:false'), '要らない問い合わせをしている'));
  check('動いていないので通知もしない', () => assert.strictEqual(notified.length, 0));

  reset();
  counts['3:7'].t += 1;                          /* その他大会に1件 増えた */
  await runTournamentInfoTask();
  check('その他大会は総数が動いたら全件を取りに行く', () =>
    assert.ok(pages.some((p) => p.startsWith('3:7:true')), '受付中の2ページ目以降を取っていない'));
  check('その他大会は総数が動いたら通知する', () =>
    assert.ok(notified.some((x) => x.label === 'その他大会' && x.n > 0), JSON.stringify(notified)));

  /* ── 満席が解けた（キャンセルで空いた）──────────────────────
     一覧には載ったままなので「新しく現れた」では拾えない。
     受け口が前の値と見比べて教えてくれる分を、ちゃんと通知に回すか。 */
  reset();
  freedToReturn = [{ id: 1246, date_id: 999001, shop_name: 'テスト店', prefecture_name: '東京都', event_date: '11/15' }];
  await runTournamentInfoTask();
  check('満席が解けたら通知する', () =>
    assert.ok(notified.some((x) => x.label === 'シティリーグ' && x.n === 1), JSON.stringify(notified)));

  /* ── 重なったときに同じ通知を2回出さない ─────────────────
     3分おきになったので、全件を見ている最中に次の回が始まりうる。
     「いま見ている」印を state に残して、次の回は譲る。 */
  reset();
  counts['3:7'].t += 1;                          /* また増えた */
  const st = JSON.parse(fs.readFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, 'utf8'));
  st.other_events.scan_started_at = Math.floor(Date.now() / 1000);   /* 別の回が見ている最中 */
  fs.writeFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, JSON.stringify(st));
  await runTournamentInfoTask();
  check('別の回が全件を見ている最中は譲る（通知を二重に出さない）', () => {
    assert.ok(!pages.some((p) => p.startsWith('3:7:true')), '譲らずに全件を取っている');
    assert.ok(!notified.some((x) => x.label === 'その他大会'), '二重に通知している');
  });

  reset();
  const st2 = JSON.parse(fs.readFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, 'utf8'));
  st2.other_events.scan_started_at = Math.floor(Date.now() / 1000) - 3600;   /* 1時間前＝前の回は落ちた */
  fs.writeFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, JSON.stringify(st2));
  await runTournamentInfoTask();
  check('印が古ければやり直す（前の回が落ちても止まらない）', () =>
    assert.ok(pages.some((p) => p.startsWith('3:7:true')), '古い印に引っかかって永久に見に行かない'));

  /* シティリーグ（毎回まるごと見る側）でも、重なったら譲るか */
  reset();
  const st3 = JSON.parse(fs.readFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, 'utf8'));
  st3.city_league.scan_started_at = Math.floor(Date.now() / 1000);
  fs.writeFileSync(process.env.TOURNAMENT_INFO_STATE_FILE, JSON.stringify(st3));
  freedToReturn = [{ id: 1246, date_id: 999002, shop_name: 'テスト店2', prefecture_name: '東京都', event_date: '11/16' }];
  await runTournamentInfoTask();
  check('シティリーグも、別の回が見ている最中は譲る', () => {
    assert.ok(!pages.some((p) => p.startsWith('3:2')), '譲らずに取りに行っている');
    assert.ok(!notified.some((x) => x.label === 'シティリーグ'), '二重に通知している');
  });
  freedToReturn = [];

  fs.rmSync(tmp, { recursive: true, force: true });
  if (ng) { console.error(`\n❌ ${ng} 件。`); process.exit(1); }
  console.log('\n✅ 総数が動いたときだけ全件を見に行き、動いた側だけ通知する');
})();
