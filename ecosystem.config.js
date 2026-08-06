module.exports = {
  apps: [
    {
      name: 'tcg-info-3min',
      script: './src/index.js',
      args: '--task=info',
      cron_restart: '*/3 * * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'tcg-rank-hourly',
      script: './src/index.js',
      args: '--task=rank',
      cron_restart: '0 * * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'tcg-result-hourly',
      script: './src/index.js',
      args: '--task=result',
      cron_restart: '10 * * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
