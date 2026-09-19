module.exports = {
  apps: [{
    name: 'k-tax-agent', cwd: __dirname, script: './dist/index.js', instances: 1,
    autorestart: true, kill_timeout: 15000, watch: false, max_memory_restart: '400M',
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 3000 }
  }]
};
