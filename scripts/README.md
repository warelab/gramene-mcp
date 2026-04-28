# scripts/

Standalone command-line utilities for batch access to the Gramene/SorghumBase data backend. Each script queries the same Solr and MongoDB services used by the MCP server; configure them with the same environment variables or `.env` files.

## Scripts

### `lof_germplasm.mjs` — Loss-of-function germplasm lookup

Reads a list of gene stable IDs and outputs every germplasm accession carrying a predicted loss-of-function allele, one population group per line.

**Usage**

```bash
# From a file
node --env-file=../.env.squam lof_germplasm.mjs gene_ids.txt

# From stdin
echo -e "SORBI_3006G095600\nSORBI_3001G095700" | node --env-file=../.env.squam lof_germplasm.mjs

# Print a header row
node --env-file=../.env.squam lof_germplasm.mjs --header gene_ids.txt
```

**Input** — plain text, one gene stable ID per line. Blank lines and lines beginning with `#` are ignored.

**Output** — tab-delimited on stdout, one row per (gene × population × consequence × zygosity) group:

| Column | Description |
|---|---|
| `gene_id` | Input gene stable ID |
| `population` | Study/population name (e.g. `Purdue EMS`, `Boatwright SAP`, `Sorghum Genomics Toolbox`) |
| `pop_type` | `EMS` (ethyl-methanesulfonate mutagenesis) or `NAT` (natural diversity) |
| `consequence` | VEP consequence class (e.g. `stop gained`, `splice acceptor variant`, `frameshift variant`) |
| `zygosity` | `homo` (homozygous) or `het` (heterozygous) |
| `accessions` | Comma-separated list of public accession IDs (`pub_id` from the germplasm collection) |

**Options**

| Flag | Default | Description |
|---|---|---|
| `--solr-url URL` | `$SOLR_BASE_URL` or `http://localhost:8983/solr` | Solr base URL |
| `--solr-core CORE` | `$SOLR_GENES_CORE` or `genes` | Solr genes core name |
| `--mongo-uri URI` | `$MONGO_URI` or `mongodb://localhost:27017` | MongoDB connection URI |
| `--mongo-db DB` | `$MONGO_DB` or `test` | MongoDB database name |
| `--batch-size N` | `50` | Number of genes per Solr query (max 50) |
| `--header` | off | Print a TSV header line as the first row |
| `--no-fallback` | off | Omit accessions that have no `pub_id` (default: fall back to internal `ens_id`) |
| `--help` | | Show usage and exit |

**Environment variables**

All connection settings can be supplied via environment variables instead of flags. The cleanest approach is to use Node's built-in `--env-file` option:

```bash
node --env-file=../.env.squam lof_germplasm.mjs gene_ids.txt
```

Or export them in your shell:

```bash
export SOLR_BASE_URL=http://squam:8983/solr
export SOLR_GENES_CORE=sorghum_genes10
export MONGO_URI=mongodb://squam:27017
export MONGO_DB=sorghum10
node scripts/lof_germplasm.mjs gene_ids.txt
```

**Example output**

```
SORBI_3006G095600	Purdue EMS	EMS	stop gained	homo	M3-1234,M3-5678
SORBI_3006G095600	USDA Lubbock EMS	EMS	frameshift variant	het	ARS105,ARS212
SORBI_3006G095600	Sorghum Genomics Toolbox	NAT	stop gained	homo	PI 514460,PI 533946,PI 601213
SORBI_3001G095700	Boatwright SAP	NAT	splice acceptor variant	homo	PI 152703
```

**Dependencies**

Requires only the `mongodb` package already installed in the project root:

```bash
# From the project root
npm install
node scripts/lof_germplasm.mjs --help
```
