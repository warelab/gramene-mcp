module.exports = {
  apps: [
    {
      name: "gramene-mcp",
      script: "server.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: {
        GRAMENE_API_BASE: "https://data.gramene.org/v69",
        MCP_HOST: "squam.cshl.edu",
        MCP_PORT: "11065",
        MCP_ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
      },
    },
  ],
};
