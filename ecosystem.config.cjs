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
        // Each site is served at /mcp/<id>. The first entry also answers the
        // bare /mcp path, so existing clients stay on sorghum_v11. Descriptions
        // are sent to MCP clients so they can tell the sites apart.
        GRAMENE_SITES: JSON.stringify([
          {
            id: "sorghum_v11",
            apiBase: "https://data.sorghumbase.org/sorghum_v11",
            description:
              "SorghumBase release 11: a sorghum pan-genome resource with 120 Sorghum genomes " +
              "plus reference outgroups (maize, rice, Arabidopsis, grape, poplar, Selaginella, " +
              "Chlamydomonas, Drosophila).",
          },
          {
            id: "v70",
            apiBase: "https://data.gramene.org/v70",
            description:
              "Gramene release 70: comparative genomics across 267 plant and algal genomes, " +
              "including pan-genome sets for barley (77 genomes), oats (33), rice (26) and " +
              "wheat (24).",
          },
          {
            id: "v69",
            apiBase: "https://data.gramene.org/v69",
            description:
              "Gramene release 69: comparative genomics across 233 plant and algal genomes, " +
              "including pan-genome sets for barley (77 genomes), rice (26) and wheat (24).",
          },
          {
            id: "oryza_v9",
            apiBase: "https://data.gramene.org/oryza_v9",
            description:
              "Gramene Oryza release 9: a rice pan-genome resource with 28 Oryza genomes " +
              "plus outgroups (Leersia, maize, sorghum, Arabidopsis, grape, Selaginella, " +
              "Chlamydomonas, Drosophila).",
          },
        ]),
        MCP_HOST: "squam.cshl.edu",
        MCP_PORT: "11065",
        MCP_ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
      },
    },
  ],
};
