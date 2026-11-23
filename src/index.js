require('dotenv').config();
const { runTournamentInfoTask } = require('./tasks/tournament_info');
const { runPlayerRankTask } = require('./tasks/player_rank');
const { runTournamentResultTask } = require('./tasks/tournament_result');
const { closeBrowserSession } = require('./browser');
const { closePool } = require('./db');
const { settleRead, sendHeartbeat } = require('./heartbeat');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

/* 🚩 「今回は取れなかった」を黙って見逃し続けないための数取り器（2026-09-24）。
   公式サイト側の403は次の回で拾い直せるのでメールを出さない（下の catch）。
   ただし**自力で治っていない**なら気づかないといけないので、
   連続で失敗した回数を state に書き、続いたらそこで落としてメールを出す。
   state/ は各ワークフローが毎回コミットして持ち回っている。 */
/* ⚠ 仕事ごとに別のファイル（2026-10-23）。1つのファイルを3つの仕事が書き戻し合い、互いの数を古い値に戻していた */
const healthFile = (task) => path.join(__dirname, `../state/upstream_health_${task || 'all'}.json`);
const MAX_CONSECUTIVE_FAILURES = 6;   /* 毎時なら約6時間ぶん */
const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;   /* しきい値の後に知らせ直す間隔 */

function loadHealth(task) {
  const HEALTH_FILE = healthFile(task);
  try {
    if (fs.existsSync(HEALTH_FILE)) return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) || {};
  } catch (e) {
    logger.warn(`upstream_health を読めませんでした: ${e.message}`);
  }
  return {};
}

function saveHealth(task, health) {
  const HEALTH_FILE = healthFile(task);
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2), 'utf8');
  } catch (e) {
    logger.warn(`upstream_health を書けませんでした: ${e.message}`);
  }
}

/** @returns 連続失敗がしきい値に達したら true（= ここで落としてメールを出す） */
function noteUpstreamFailure(task, reason) {
  const health = loadHealth(task);
  const key = task || 'all';
  const cur = health[key] || {};
  const n = (cur.consecutive_failures || 0) + 1;
  health[key] = {
    consecutive_failures: n,
    last_failure_at: new Date().toISOString(),
    last_reason: String(reason || '').slice(0, 300)
  };
  /* 🚩 2026-10-22: しきい値を超えた後は**毎回**落ちていて、15分おきにメールが飛んだ（公式のメンテナンス中・1日に数十通）。
     知らせるのは「しきい値に達した回」と、その後は1日1回だけ。直れば noteUpstreamOk で数え直す。 */
  let alert = false;
  if (n >= MAX_CONSECUTIVE_FAILURES) {
    const last = cur.last_alert_at ? Date.parse(cur.last_alert_at) : 0;
    if (n === MAX_CONSECUTIVE_FAILURES || !last || Date.now() - last >= ALERT_EVERY_MS) {
      alert = true;
      health[key].last_alert_at = new Date().toISOString();
    } else {
      health[key].last_alert_at = cur.last_alert_at;
    }
  }
  saveHealth(task, health);
  logger.warn(`公式サイト側の失敗 ${n} 回目（連続）。${MAX_CONSECUTIVE_FAILURES} 回目と、その後は1日1回だけ知らせます`);
  return alert;
}

function noteUpstreamOk(task) {
  const health = loadHealth(task);
  const key = task || 'all';
  if (health[key] && health[key].consecutive_failures) {
    logger.info(`公式サイト側は復調しました（${health[key].consecutive_failures} 回連続の失敗から回復）`);
  }
  health[key] = { consecutive_failures: 0, last_ok_at: new Date().toISOString() };
  saveHealth(task, health);
}

async function main() {
  const args = process.argv.slice(2);
  const taskArg = args.find(a => a.startsWith('--task=')) || '';
  const taskName = taskArg.replace('--task=', '').trim();

  logger.info(`=== Executing TCG Runner Task: [${taskName || 'all'}] ===`);

  /* 🚩 2026-11-23: 「公式を読めたか」を各仕事が返す。読めなければ連続失敗として数え（続いたら落とす＝メール）、
     どちらの場合も「生きている印」をポケミミへ送る（管理画面の判定と運営への通知はポケミミ側）。
     ⚠ 1回読めないだけでは落とさない（2026-08-14 ユーザー指示「取得できない時もあるわけだから、エラーにならないようにしとけば？」）。
        すぐ判るのは印の側（ポケミミの管理画面が「読めなかった」をその場で出す）。 */
  const hooks = {
    onOk: noteUpstreamOk,
    onFail: (task, reason) => {
      const alert = noteUpstreamFailure(task, reason);
      if (alert) logger.error(`公式を ${MAX_CONSECUTIVE_FAILURES} 回続けて読めていません（${task}）。自力で治っていないので落とします`);
      return alert;
    }
  };
  const settle = async (task, res) => {
    const { fail } = await settleRead(task, res, hooks);
    if (fail) process.exitCode = 1;
  };
  const resultRead = (res) => ({
    readOk: !!res && !res.feedFailed,
    total: res ? res.feedTotal : null,
    reason: res && res.feedFailed ? `最近の大会一覧が取れなかった: ${res.feedReason || ''}` : '',
    detail: res ? res.detail : ''
  });

  try {
    switch (taskName) {
      case 'info':
        await settle('info', await runTournamentInfoTask());
        break;
      case 'rank':
        await settle('rank', await runPlayerRankTask());
        break;
      case 'result':
        /* フィードが取れなかった回は「0件」ではない。連続したら落とす */
        await settle('result', resultRead(await runTournamentResultTask()));
        break;
      default:
        logger.info('No specific task specified. Running all tasks sequentially...');
        await runTournamentInfoTask();
        await runPlayerRankTask();
        await runTournamentResultTask();
        break;
    }
  } catch (err) {
    /* 途中で落ちた回も「読めなかった」と印に送る（届かなければポケミミ側で古いと判る） */
    if (['info', 'rank', 'result'].includes(taskName)) {
      await sendHeartbeat(taskName, { ok: false, detail: `途中で落ちた: ${err && err.message}` });
    }
    /* 🚨 **「今回は取れなかった／送れなかった」は失敗ではない**（2026-08-14 ユーザー指示）。
     *
     *   この仕組みは 5分〜1時間おきに回り続ける。未処理ぶんは**サーバ側に残る**ので、
     *   通信が詰まった回は何もしなくても**次の回が同じものを拾い直す**。
     *   それで毎回メールを出すと、人はメールを見なくなり、
     *   **本当に壊れた日に気づけなくなる**。だから止めるのは「自力で治らない失敗」だけ。
     *
     *   落とす（＝メールが飛ぶ）: 鍵ちがい・送り方ちがい・受け口が「だめ」と答えた・コードの不具合
     *   落とさない（警告だけ）  : 返事が来ない／タイムアウト／相手が 5xx
     */
    if (err && err.pmTransient) {
      const where = err.pmUpstream ? '公式サイト' : '受け口';
      logger.warn(`今回は${where}から取れませんでした（次の回で拾い直します）: ${err.message}`);
      console.log(`::warning::今回は${where}から取れませんでした。未処理ぶんは次の回で拾い直します`);
      /* ⚠ 黙らせっぱなしにはしない。続くようなら自力で治っていないので落とす */
      if (noteUpstreamFailure(taskName, err.message)) {
        logger.error(`${MAX_CONSECUTIVE_FAILURES} 回続けて取れていません。自力で治っていないので落とします`);
        process.exitCode = 1;
      }
    } else {
      logger.error('Unhandled task error:', err.stack || err.message);
      process.exitCode = 1;
    }
  } finally {
    await closeBrowserSession();
    await closePool();
    logger.info(`=== Task [${taskName || 'all'}] Execution Finished ===`);
  }
}

main();
