module.exports = {
  apps: [
    {
      name: "k-tax-agent",
      cwd: __dirname,
      script: "./dist/index.js",
      instances: 1,
      autorestart: true,
      kill_timeout: 15000,
      watch: false,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    },
    {
      name: "ktax-tunnel",
      script: "C:\\Users\\ihavg\\.gemini\\antigravity-cli\\bin\\cloudflared.exe",
      args: "tunnel run ktax-law",
      autorestart: true,
      watch: false
    }
  ]
};
