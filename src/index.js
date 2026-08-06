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
    logger.error('Unhandled task error:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await closeBrowserSession();
    await closePool();
    logger.info(`=== Task [${taskName || 'all'}] Execution Finished ===`);
  }
}

main();
