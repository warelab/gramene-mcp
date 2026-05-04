module.exports = {
  apps: [
    {
      name: "gramene-mcp-sorghum10",
      script: "server.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: {
        SOLR_BASE_URL: "http://localhost:8983/solr",
        SOLR_GENES_CORE: "sorghum_genes10",
        SOLR_SUGGESTIONS_CORE: "sorghum_suggestions10",
        MONGO_URI: "mongodb://localhost:27017",
        MONGO_DB: "sorghum10",
        MCP_HOST: "squam.cshl.edu",
        MCP_PORT: "11065",
        MCP_ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
      },
    },
  ],
};
