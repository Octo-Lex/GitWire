// ecosystem.config.cjs
// PM2 process config for production VPS.
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   ← auto-start on reboot

module.exports = {
  apps: [
    {
      name:        "gitops-hub",
      script:      "./src/index.js",
      interpreter: "node",
      node_args:   "--experimental-vm-modules",
      instances:   2,             // Run 2 Node processes (cluster mode)
      exec_mode:   "cluster",
      watch:       false,
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
        PORT:     3000,
      },
      // Rotate logs
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file:  "./logs/pm2-error.log",
      out_file:    "./logs/pm2-out.log",
      merge_logs:  true,
    },
  ],
};
