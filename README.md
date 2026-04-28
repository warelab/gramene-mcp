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

## Connecting to Claude

### Claude Desktop

Add an entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gramene": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

### Claude Code / Cowork

```bash
claude mcp add gramene --url http://127.0.0.1:8787/mcp
```

Once connected, Claude will automatically discover all available tools and workflow prompts.

## Tools

The server exposes 13 tools:

| Tool | Description |
|---|---|
| `solr_search` | Full Solr query against the genes core — field lists, filters, facets, sorting, pagination |
| `solr_suggest` | Translate a natural-language term (gene name, species, pathway, ontology) into a Solr filter query |
| `solr_search_bool` | Structured AND/OR/NOT boolean queries without raw Solr syntax |
| `solr_graph` | Traverse gene relationship graphs (e.g. genomic neighbourhoods via `compara_neighbors_10`) |
| `genes_in_region` | Find all genes overlapping a chromosomal interval |
| `expression_for_genes` | Baseline (TPM/FPKM) and differential (log₂FC) expression by tissue and condition |
| `vep_for_gene` | Germplasm accessions carrying predicted loss-of-function alleles (Ensembl VEP), grouped by consequence, zygosity, and study |
| `enrichment_analysis` | Hypergeometric overrepresentation test for GO, Plant Ontology, Trait Ontology, domains, or pathways |
| `pubmed_for_genes` | PubMed papers linked to a set of genes via NCBI E-utilities |
| `mongo_find` | Raw MongoDB `find()` against any collection |
| `mongo_lookup_by_ids` | Batch-resolve numeric ontology term IDs to names |
| `mongo_list_collections` | List all collections in the configured database |
| `kb_relations` | Return the Solr ↔ MongoDB field crosswalk (schema documentation) |

## Workflow prompts

The server also exposes workflow prompts that Claude loads on demand to guide multi-step research tasks:

- **base** — Role definition, query routing, species reference table, and critical conventions
- **gene_lookup** — Search by gene/protein name or molecular function
- **pathway_genes** — List genes in a Plant Reactome pathway for a given species
- **qtl_candidate_ranking** — Full pipeline for ranking candidate genes within a QTL interval
- **cross_species_comparison** — Compare a gene across orthologs in multiple species
- **orthologs_paralogs** — Discover paralogs within a species
- **gene_family** — Explore a gene family across species
- **germplasm_lof** — Find EMS and natural-diversity knockout lines for target genes
- **enrichment** — Run ontology enrichment on a gene set
- **pav_cnv** — Analyse presence/absence and copy-number variation via facets
- **literature_search** — Discover papers linked to a gene set

## Data model

Gramene-MCP combines two backends:

**Solr** (`genes` core) — one document per gene, across 30+ plant species. Key field groups:

- Gene identity: `id`, `name`, `description`, `biotype`, `taxon_id`, `region`, `start`, `end`, `strand`
- Ontology ancestors: `GO__ancestors`, `PO__ancestors`, `TO__ancestors`, `pathways__ancestors`, `domains__ancestors`
- Comparative genomics: `gene_tree`, `compara_neighbors_N`, `compara_idx_multi` (PAV/CNV)
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
- **Taxon IDs** come in two flavours: `taxonomy__ancestors` uses plain NCBI IDs (e.g. `4558` for sorghum); the `taxon_id` field uses `NCBI_ID × 1000 + suffix` (e.g. `4558001`).
- **`solr_graph`** must always be called with `maxDepth: 1` to avoid unbounded traversal.
- **Species suggestions** work best with an exact-name query (`q: 'name:"Sorghum bicolor"'`) rather than a fuzzy `term:` lookup.
- **Expression data** is richest for sorghum; VEP loss-of-function data covers sorghum, maize, and several rice genomes.
