# gramene-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects Claude and other AI agents to the [Gramene](https://www.gramene.org/) plant genomics database. It exposes a suite of tools covering gene search, comparative genomics, expression, loss-of-function germplasm, ontology enrichment, and literature discovery — all backed by a Solr search index and a MongoDB annotation store.

## Requirements

- **Node.js** v18 or later (ES modules + native `fetch`)
- **Apache Solr** 9 with a `genes` core and a `suggestions` core
- **MongoDB** 7

For local development both can be started via the included Docker Compose setup (see [Local development](#local-development) below).

## Installation

```bash
git clone https://github.com/warelab/gramene-mcp.git
cd gramene-mcp
npm install
```

## Configuration

Copy `.env.example` and edit to match your environment:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Interface to listen on |
| `MCP_PORT` | `8787` | Port to listen on |
| `MCP_ALLOWED_ORIGINS` | _(localhost only)_ | Comma-separated CORS origins; set to `*` to allow all |
| `MCP_LOG` | `true` | Write JSON request logs to stderr |
| `MCP_LOG_FILE` | _(none)_ | Optional path for a persistent log file |
| `SOLR_BASE_URL` | `http://localhost:8983/solr` | Solr base URL |
| `SOLR_GENES_CORE` | `genes` | Name of the genes Solr core |
| `SOLR_SUGGESTIONS_CORE` | `suggestions` | Name of the suggestions Solr core |
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection URI |
| `MONGO_DB` | `test` | MongoDB database name |

The `.env.squam` file in the repo is a ready-made config pointing at the Gramene production instance on `squam`.

## Starting the server

```bash
# Using your own .env
npm start

# Using the squam production instance
npm run start:squam

# Development mode (auto-reloads on file changes)
npm run dev
npm run dev:squam
```

The server listens for MCP JSON-RPC requests at `POST http://<MCP_HOST>:<MCP_PORT>/mcp`.

## Connecting to MCP clients

The server speaks the [MCP 2025-03-26 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport — a single `POST /mcp` endpoint that any compliant client can use.

### Claude Desktop

Add an entry to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gramene": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code / Cowork

```bash
claude mcp add gramene --url http://127.0.0.1:8787/mcp
```

### VS Code (GitHub Copilot)

Create or edit `.vscode/mcp.json` in your workspace (or add to user settings under `mcp.servers` for a global entry):

```json
{
  "servers": {
    "gramene": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Open the Chat view, select **Agent** mode, and the gramene tools will appear in the tools picker.

### Cursor

Create or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "gramene": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Open **Cursor Settings → MCP** to verify the server is listed and active.

### Zed

Open your Zed `settings.json` (`zed: open settings`) and add a `context_servers` entry:

```json
{
  "context_servers": {
    "gramene": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Zed supports the MCP HTTP transport natively. If your server requires authentication, add a `headers` map:

```json
{
  "context_servers": {
    "gramene": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### OpenAI Codex

Edit `~/.codex/config.toml` (global) or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.gramene]
url = "http://127.0.0.1:8787/mcp"
```

Or add it from the CLI:

```bash
codex mcp add gramene --url http://127.0.0.1:8787/mcp
```

Both the Codex CLI and the Codex IDE extension share this config file, so you only need to set it up once.

### Continue.dev

Add to `.continue/config.yaml` (or the JSON equivalent) in your project or home directory:

```yaml
mcpServers:
  - name: gramene
    transport:
      type: http
      url: http://127.0.0.1:8787/mcp
```

See the [Continue MCP docs](https://docs.continue.dev/customize/model-context-protocol) for authentication options and tool filtering.

### Any MCP-compliant client

The server endpoint is:

```
POST http://<host>:<port>/mcp
Content-Type: application/json
```

It accepts standard MCP JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`). Sessions are tracked via the `Mcp-Session-Id` header returned on `initialize` — echo it back on subsequent requests if your client supports session continuity.

If the server is on a remote host, make sure `MCP_ALLOWED_ORIGINS` is set to allow your client's origin, or set it to `*` for unrestricted access.

## Tools

The server exposes 12 tools:

| Tool | Description |
|---|---|
| `solr_search` | Full Solr query against the genes core — field lists, filters, facets, sorting, pagination. Use for single-gene cards (`q="id:…"`) and to produce facet-count arrays consumed by the client-side enrichment skill |
| `solr_suggest` | Entry point for free-text concepts (gene name, family, pathway, species, ontology, trait) → `fq_field`/`fq_value`. Always start here before `mongo_find` |
| `solr_search_bool` | Structured AND/OR/NOT boolean queries without raw Solr syntax |
| `solr_graph` | Single-hop graph traversal (e.g. genomic neighbourhoods via `compara_neighbors_10`). Multi-hop relationships are expressed by chaining two queries |
| `genes_in_region` | Find all genes overlapping a chromosomal interval. `taxon_id` is the plain NCBI ID |
| `expression_for_genes` | Baseline (TPM/FPKM) and differential (log₂FC) expression by tissue and condition |
| `vep_for_gene` | Germplasm accessions carrying predicted loss-of-function alleles (Ensembl VEP), grouped by consequence, zygosity, and study |
| `pubmed_for_genes` | PubMed and DOI cross-references for a set of genes (returns IDs only — pipe to a PubMed-focused MCP for bibliographic detail) |
| `mongo_find` | MongoDB `find()` for detail lookups by known ID — not for discovery |
| `mongo_lookup_by_ids` | Batch-resolve numeric ontology term IDs to names |
| `mongo_list_collections` | List all collections in the configured database |
| `kb_relations` | Return the Solr ↔ MongoDB field crosswalk (schema documentation) |

**Enrichment / overrepresentation analysis is intentionally not an MCP tool.**
Build foreground and background facet-count arrays via `solr_search` (with
`facet.field` on `GO__ancestors`, `PO__ancestors`, `TO__ancestors`,
`pathways__ancestors`, or `domains__ancestors`) and pass them to a
client-side enrichment skill that operates on (ontology, foreground array,
background array).

## Workflow prompts

The server also exposes workflow prompts that Claude loads on demand to guide multi-step research tasks:

- **base** — Role definition, query routing, species reference table, and critical conventions
- **gene_lookup** — Search by gene/protein name or molecular function
- **pathway_genes** — List genes in a Plant Reactome pathway for a given species
- **qtl_discovery** — Resolve a free-text trait to a TO term and list matching QTLs
- **qtl_candidate_ranking** — Full pipeline for ranking candidate genes within a QTL interval
- **cross_species_comparison** — Compare a gene across orthologs in multiple species
- **orthologs_paralogs** — Field reference for ortholog / paralog / homolog queries
- **gene_family** — Explore a gene family across species
- **gene_family_expansion** — Per-clade copy counts via `gene_tree` × `taxonomy__ancestors` faceting
- **germplasm_lof** — Find EMS and natural-diversity knockout lines for target genes
- **pav_cnv** — Analyse presence/absence and copy-number variation via facets or chained graph traversal
- **literature_search** — Collect PubMed/DOI cross-references for a gene (and its orthologs) to hand off to a PubMed-focused MCP

## Data model

Gramene-MCP combines two backends:

**Solr** (`genes` core) — one document per gene, across 30+ plant species. Key field groups:

- Gene identity: `id`, `name`, `description`, `biotype`, `taxon_id`, `region`, `start`, `end`, `strand`
- Species filtering: `taxonomy__ancestors` (plain NCBI taxon IDs at every rank — preferred)
- Ontology ancestors: `GO__ancestors`, `PO__ancestors`, `TO__ancestors`, `pathways__ancestors`, `domains__ancestors`
- Comparative genomics: `gene_tree`, `homology__all_orthologs`, `homology__ortholog_one2one`/`one2many`/`many2many`, `homology__within_species_paralog`, `compara_neighbors_N`, `compara_idx_multi` (PAV/CNV)
- Expression linkage: `expressed_in_gxa_attr_ss` (joins to MongoDB `experiments` and `assays`)
- Loss-of-function: `VEP__{consequence}__{zygosity}__{species}__{study}__attr_ss`, `VEP__merged__EMS/NAT__attr_ss`
- Literature: `PUBMED__xrefs`

**MongoDB** — annotation collections used for enrichment and metadata lookups:

| Collection | Contents |
|---|---|
| `genes` | Gene-level metadata |
| `genetree` | Gene family / homology trees |
| `taxonomy` | NCBI taxonomy nodes |
| `GO`, `PO`, `TO` | Ontology term documents |
| `domains`, `pathways` | InterPro domains and Plant Reactome pathways |
| `assays`, `experiments`, `expression` | Expression study metadata and values |
| `qtls` | QTL records with Trait Ontology annotations |
| `germplasm` | Accession metadata: `pub_id`, `stock_center`, `subpopulation`, genebank URL |
| `maps` | Genome assembly metadata (`in_compara` flag) |

## Local development

The `seed/` directory contains everything needed to spin up a local Solr + MongoDB stack with sample data:

```bash
# Start containers, apply schemas, and load sample data
./seed/setup-test-env.sh

# Start the MCP server against the local stack
MONGO_DB=gramene npm start

# Run integration tests
npm test

# Tear down containers
./seed/setup-test-env.sh --down
```

The Docker Compose stack runs `mongo:7` and `solr:9` with health checks, persistent volumes, and automatic schema + seed-data loading.

## Command-line utilities

Standalone scripts for batch data access are in the [`scripts/`](scripts/) directory. See [scripts/README.md](scripts/README.md) for full documentation.

## Conventions

A few quirks to be aware of when using the tools directly:

- **Gene IDs** must be full stable IDs (e.g. `SORBI_3006G095600`), never abbreviated.
- **Taxon IDs** — filter with `taxonomy__ancestors:<plain NCBI id>` (e.g. `4558` for sorghum). The `taxon_id` *field* on individual gene documents uses `NCBI×1000+suffix` (e.g. `4558001`); avoid filtering on it directly. The `genes_in_region` `taxon_id` parameter takes the plain NCBI ID and applies it as `taxonomy__ancestors`.
- **`solr_graph`** is single-hop by design; depth is hard-coded server-side. Multi-hop relationships are expressed by chaining two graph queries (e.g. orthologs → neighbors).
- **Discovery vs detail.** Always start free-text discovery with `solr_suggest`. Reserve `mongo_find` for fetching detail records once you have a specific ID.
- **Homology field choice.** Default to `homology__all_orthologs`. Use `homology__ortholog_one2one` only for tight pairs (e.g. sorghum ↔ rice); maize is a paleopolyploid, and monocot ↔ Arabidopsis is too distant for stable 1:1 mappings.
- **Species suggestions** work best with an exact-name query (`q: 'name:"Sorghum bicolor"'`) rather than a fuzzy `term:` lookup. The same applies to pathway and Trait Ontology lookups (`fq: ['category:Trait Ontology']`).
- **Expression data** is richest for sorghum; VEP loss-of-function data covers sorghum, maize, and several rice genomes.
