require('dotenv').config();
const { runTournamentInfoTask } = require('./tasks/tournament_info');
const { runPlayerRankTask } = require('./tasks/player_rank');
const { runTournamentResultTask } = require('./tasks/tournament_result');
const { closeBrowserSession } = require('./browser');
const { closePool } = require('./db');
const logger = require('./logger');

async function main() {
  const args = process.argv.slice(2);
  const taskArg = args.find(a => a.startsWith('--task=')) || '';
  const taskName = taskArg.replace('--task=', '').trim();

  logger.info(`=== Executing TCG Runner Task: [${taskName || 'all'}] ===`);

  try {
    switch (taskName) {
      case 'info':
        await runTournamentInfoTask();
        break;
      case 'rank':
        await runPlayerRankTask();
        break;
      case 'result':
        await runTournamentResultTask();
        break;
      default:
        logger.info('No specific task specified. Running all tasks sequentially...');
        await runTournamentInfoTask();
        await runPlayerRankTask();
        await runTournamentResultTask();
        break;
    }
  } catch (err) {
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
      logger.warn(`今回は届きませんでした（次の回で拾い直します）: ${err.message}`);
      console.log('::warning::今回は受け口に届きませんでした。未処理ぶんは次の回で拾い直します');
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
