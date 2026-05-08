import fs from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

/**
 * Gramene MCP Server — bridges Claude to Solr search and MongoDB.
 *
 * Environment variables:
 *   MCP_HOST             Listen address          (default: 127.0.0.1)
 *   MCP_PORT             Listen port             (default: 8787)
 *   MCP_ALLOWED_ORIGINS  Comma-separated origins (default: localhost only)
 *   MCP_MAX_BODY_BYTES   Max request body size   (default: 1048576 / 1 MB)
 *   MCP_LOG              Set to "false" to disable JSON logging to stderr  (default: true)
 *   MCP_LOG_FILE         Path to append JSON log lines (persists across restarts)
 *   MCP_LOG_BUFFER_SIZE  Max tool_call events kept in memory for the dashboard (default: 10000)
 *
 *   SOLR_BASE_URL        Solr base URL           (default: http://localhost:8983/solr)
 *   SOLR_GENES_CORE      Solr genes core name    (default: genes)
 *   SOLR_SUGGESTIONS_CORE  Suggestions core name (default: suggestions)
 *
 *   MONGO_URI            MongoDB connection URI  (default: mongodb://localhost:27017)
 *   MONGO_DB             Database name           (default: test)
 */

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || "8787");
const MAX_BODY_BYTES = Number(process.env.MCP_MAX_BODY_BYTES || "1048576");

const SOLR_BASE_URL = process.env.SOLR_BASE_URL || "http://localhost:8983/solr";
const SOLR_GENES_CORE = process.env.SOLR_GENES_CORE || "genes";
const SOLR_SUGGESTIONS_CORE = process.env.SOLR_SUGGESTIONS_CORE || "suggestions";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const MONGO_DB = process.env.MONGO_DB || "test";

// Single source of truth for server identity. Used by both the MCP `initialize`
// reply (over JSON-RPC) and the GET /mcp discovery endpoint (for clients that
// want to inspect transport, protocol versions, and capabilities without an
// initialize round-trip — modeled on https://pubmed.caseyjhand.com/mcp).
const SERVER_NAME = "gramene-mcp";
const SERVER_VERSION = "0.3.0";
const SERVER_DESCRIPTION =
  "MCP server bridging AI agents to the Gramene plant genomics database " +
  "(Solr search index + MongoDB annotation store). Tools cover gene search, " +
  "comparative genomics, expression, ontology / QTL annotations, predicted " +
  "loss-of-function germplasm, and literature cross-references.";
const SERVER_HOMEPAGE = "https://github.com/warelab/gramene-mcp";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25"];
const SERVER_CAPABILITIES = {
  tools:     { listChanged: false },
  prompts:   { listChanged: false },
  resources: false,
  logging:   false,
};

function getServerDiscoveryDoc() {
  return {
    status: "ok",
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: SERVER_DESCRIPTION,
      homepage: SERVER_HOMEPAGE,
      environment: process.env.NODE_ENV || "production",
      transport: "http",
      sessionMode: "session",
    },
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: {
      tools:     SERVER_CAPABILITIES.tools     !== false,
      prompts:   SERVER_CAPABILITIES.prompts   !== false,
      resources: SERVER_CAPABILITIES.resources !== false,
      logging:   SERVER_CAPABILITIES.logging   !== false,
    },
    endpoints: {
      mcp:       "/mcp",
      dashboard: "/mcp/usage",
      stats:     "/mcp/usage/data",
    },
    auth: { mode: "none" },
  };
}

const ALLOWED_ORIGINS = new Set(
  (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.has("*");

// --- Logging ---
// Writes a single JSON line to stderr. Set MCP_LOG=false to suppress.
// Optionally appends to MCP_LOG_FILE for dashboard persistence across restarts.
const LOGGING_ENABLED = process.env.MCP_LOG !== "false";
const LOG_FILE = process.env.MCP_LOG_FILE || null;
const LOG_BUFFER_SIZE = Number(process.env.MCP_LOG_BUFFER_SIZE || "10000");

// In-memory ring buffer — only tool_call events are stored here.
const logBuffer = [];

function log(event) {
  if (!LOGGING_ENABLED) return;
  const entry = { ts: new Date().toISOString(), ...event };
  process.stderr.write(JSON.stringify(entry) + "\n");
  if (entry.event === "tool_call") {
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  }
  if (LOG_FILE) {
    fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", () => {});
  }
}

// Read tool_call events from MCP_LOG_FILE (returns array, newest-last).
async function readLogFile() {
  if (!LOG_FILE) return [];
  try {
    const text = await fs.promises.readFile(LOG_FILE, "utf8");
    return text.split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(e => e && e.event === "tool_call");
  } catch {
    return [];
  }
}

// Compute dashboard stats from an array of tool_call events.
function computeStats(events) {
  const byTool = {};
  let errors = 0;
  let totalMs = 0;
  const cutoff1h = Date.now() - 3600_000;
  const cutoff24h = Date.now() - 86_400_000;
  let calls1h = 0, calls24h = 0;

  for (const e of events) {
    const t = byTool[e.tool] || (byTool[e.tool] = { tool: e.tool, calls: 0, errors: 0, totalMs: 0 });
    t.calls++;
    if (e.status !== "ok") { t.errors++; errors++; }
    if (e.ms) { t.totalMs += e.ms; totalMs += e.ms; }
    const ts = new Date(e.ts).getTime();
    if (ts >= cutoff1h) calls1h++;
    if (ts >= cutoff24h) calls24h++;
  }

  const toolStats = Object.values(byTool)
    .sort((a, b) => b.calls - a.calls)
    .map(t => ({ ...t, avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0 }));

  // Per-session aggregation
  const bySession = {};
  for (const e of events) {
    if (!e.session) continue;
    const s = bySession[e.session] || (bySession[e.session] = {
      session: e.session, calls: 0, errors: 0, firstSeen: e.ts, lastSeen: e.ts, tools: {}
    });
    s.calls++;
    if (e.status !== "ok") s.errors++;
    if (e.ts > s.lastSeen) s.lastSeen = e.ts;
    if (e.ts < s.firstSeen) s.firstSeen = e.ts;
    s.tools[e.tool] = (s.tools[e.tool] || 0) + 1;
  }
  const sessions = Object.values(bySession)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
    .slice(0, 50); // cap at 50 most recent sessions

  return {
    total: events.length,
    errors,
    errorRate: events.length ? ((errors / events.length) * 100).toFixed(1) : "0.0",
    avgMs: events.length ? Math.round(totalMs / events.length) : 0,
    calls1h,
    calls24h,
    byTool: toolStats,
    sessions,
    recent: events.slice(-100).reverse(),
    source: LOG_FILE ? "file" : "memory",
    buffered: logBuffer.length,
  };
}

// --- Session tracking ---
// Sessions are created on 'initialize' and identified by a UUID returned in the
// X-MCP-Session response header. Clients echo it back on subsequent requests.
// Sessions older than SESSION_TTL_MS are pruned on each new initialize.
const SESSION_TTL_MS = 24 * 3600_000; // 24 hours
const activeSessions = new Map(); // id -> { created, lastSeen, calls, errors }

function getOrCreateSession(sessionId) {
  if (sessionId && activeSessions.has(sessionId)) return sessionId;
  return null;
}

function pruneOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of activeSessions) {
    if (new Date(s.lastSeen).getTime() < cutoff) activeSessions.delete(id);
  }
}

// --- Mongo ---
// MongoClient v5+ auto-connects on first operation; no manual connect needed.
const mongoClient = new MongoClient(MONGO_URI);
function db() {
  return mongoClient.db(MONGO_DB);
}

// --- Metadata cache ---
//
// Slow-changing collections are loaded into memory at startup and refreshed
// once per day. Tools that previously made a per-call mongo round-trip for
// experiment / assay / ontology lookups should read from this cache instead.
//
// Refresh strategy: countDocuments() is cheap; if it differs from the cached
// count we reload that collection. This catches inserts/deletes but NOT
// in-place updates that don't change the doc count — acceptable because these
// collections (ontology terms, experiment metadata) almost never see in-place
// edits in practice.

const CACHED_COLLECTIONS = [
  "experiments", "assays", "taxonomy", "qtls",
  "PO", "TO", "GO", "pathways", "domains",
];

const cache = Object.fromEntries(
  CACHED_COLLECTIONS.map((name) => [name, { docs: new Map(), count: 0, loadedAt: null }])
);

async function loadCachedCollection(name) {
  const t0 = Date.now();
  const docs = await db().collection(name).find({}).toArray();
  cache[name].docs = new Map(docs.map((d) => [d._id, d]));
  cache[name].count = docs.length;
  cache[name].loadedAt = Date.now();
  log({ event: "cache_load", collection: name, count: docs.length, ms: Date.now() - t0 });
}

async function initMetadataCache() {
  const t0 = Date.now();
  await Promise.all(CACHED_COLLECTIONS.map(loadCachedCollection));
  log({ event: "cache_init_complete", ms: Date.now() - t0 });
}

const CACHE_REFRESH_MS = 24 * 3600_000;
function startCacheRefresh() {
  setInterval(async () => {
    for (const name of CACHED_COLLECTIONS) {
      try {
        const n = await db().collection(name).countDocuments();
        if (n !== cache[name].count) {
          log({ event: "cache_count_changed", collection: name, before: cache[name].count, after: n });
          await loadCachedCollection(name);
        }
      } catch (err) {
        log({ event: "cache_refresh_error", collection: name, error: String(err?.message || err) });
      }
    }
  }, CACHE_REFRESH_MS).unref();
}

function cacheGet(name, id) {
  return cache[name]?.docs.get(id);
}
function cacheValues(name) {
  return cache[name]?.docs.values();
}

// --- Helpers ---
function send(res, status, bodyObj, headers = {}) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  res.writeHead(status, {
    "Content-Type": bodyObj
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message, ...(data !== undefined ? { data } : {}) };
  return { jsonrpc: "2.0", id, error: err };
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const c of req) {
    totalBytes += c.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("Empty body");
  return JSON.parse(raw);
}

const LOCALHOST_PATTERNS = [
  "http://localhost:",
  "https://localhost:",
  "http://127.0.0.1:",
  "https://127.0.0.1:",
  "http://[::1]:",
  "https://[::1]:",
];

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                      // no Origin header → allow
  if (ALLOW_ALL_ORIGINS) return true;            // MCP_ALLOWED_ORIGINS=* → allow all
  if (ALLOWED_ORIGINS.size > 0) return ALLOWED_ORIGINS.has(origin);
  return LOCALHOST_PATTERNS.some((p) => origin.startsWith(p));
}

const KB_RELATIONS = {
  solr: {
    genes: {
      core: SOLR_GENES_CORE,
      fields: {
        taxonomy__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "taxonomy", key: "_id" } },
          description: "Taxonomy ancestor ids (match taxonomy._id)"
        },
        GO__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "gene_ontology", key: "_id" } }
        },
        PO__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "plant_ontology", key: "_id" } }
        },
        TO__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "trait_ontology", key: "_id" } }
        },
        domains__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "domains", key: "_id" } }
        },
        pathways__ancestors: {
          type: "int[]",
          references: { mongo: { collection: "pathways", key: "_id" } }
        },
        QTL_TO__ancestors: {
          type: "string[]",
          references: { mongo: { collection: "qtls", key: "_id" } },
          description: "QTL stable IDs whose interval overlaps this gene's locus. Each value joins to the qtls mongo collection (qtls._id), where each QTL document carries its TO terms, location, population, and source publications."
        },
        compara_idx: {
          type: "pint",
          description: "Single compara index for this gene (unique per species)"
        },
        compara_idx_multi: {
          type: "pint[]",
          description: "Multi-species compara index IDs for this gene. Use as the 'to' field in {!graph} traversals"
        },
        "compara_neighbors_*": {
          type: "pint[]",
          dynamicField: true,
          description: "IDs of the ±N flanking genes (e.g. compara_neighbors_10). Values are compara_idx_multi values of neighbors. Use as the 'from' field in {!graph} traversals"
        },
        pan_tree: {
          type: "string",
          description: "Pan-gene tree identifier"
        },
        // Homology fields (Ensembl Compara classification)
        // 'homologs' = all genes in the same gene tree → use gene_tree field
        // 'orthologs' = subset of homologs separated by speciation events
        // 'paralogs'  = subset of homologs separated by duplication events
        gene_tree: {
          type: "string",
          description: "Gene family tree stable ID (e.g. SB10GT_332720). All genes sharing this ID are homologs (orthologs + paralogs). Use gene_tree:<id> to retrieve the full homolog set."
        },
        gene_tree_root_taxon_id: {
          type: "pint",
          description: "NCBI taxon ID of the root node of the gene family tree. Indicates the deepest clade covered by this homolog set."
        },
        homology__all_orthologs: {
          type: "string[]",
          description: "Union of all ortholog types across all species — genes inferred to descend from the same ancestral gene via speciation (not duplication). Use this field when any ortholog is acceptable regardless of duplication history."
        },
        homology__ortholog_one2one: {
          type: "string[]",
          description: "Highest-confidence orthologs: strict 1:1 relationship — exactly one gene in each species. Implies no lineage-specific duplications since the speciation event. Preferred for cross-species functional inference (e.g. homology__ortholog_one2one:SORBI_3006G095600)."
        },
        homology__ortholog_one2many: {
          type: "string[]",
          description: "1:many orthologs — one gene in this species, multiple orthologs in the target species (duplication occurred in the target lineage after speciation). Lower confidence for 1:1 functional equivalence."
        },
        homology__ortholog_many2many: {
          type: "string[]",
          description: "Many:many orthologs — duplications occurred in both lineages after speciation. Lowest-confidence ortholog type; may include functional divergence."
        },
        homology__within_species_paralog: {
          type: "string[]",
          description: "Intra-species paralogs — genes in the same species that diverged by gene duplication. Use to find paralogous gene families within a genome."
        },
        homology__gene_split: {
          type: "string[]",
          description: "Gene-split pairs — two gene models that together represent one ancestral gene, typically due to assembly fragmentation. The split partners share a gene tree and are listed here."
        },
        "homology__*": {
          type: "string[]",
          dynamicField: true,
          description: "Other dynamic homology relationship fields following the homology__<type> pattern. The specific fields above cover all types currently populated in Gramene."
        },
        system_name: {
          type: "string",
          description: "Genome assembly identifier, e.g. 'sorghum_bicolor_btx623'. Facet on this field to count genes per genome — essential for PAV/CNV analysis across a pangenome."
        },
        transcript__length: {
          type: "pint",
          description: "Length in base pairs of the canonical transcript (longest CDS-containing isoform). Suitable for range faceting to generate transcript length distributions. E.g. range facet with start=0, end=30000, gap=500."
        },
        transcript__count: {
          type: "pint",
          description: "Number of annotated transcript isoforms for this gene locus."
        },
        transcript__exons: {
          type: "pint",
          description: "Number of exons in the canonical transcript. Range facet with start=1, end=50, gap=1 gives exon count distribution."
        },
        "protein__length": {
          type: "pint[]",
          description: "Lengths in amino acids of all annotated protein isoforms for this gene. Array because genes may have multiple isoforms."
        },
        map: {
          type: "string",
          description: "Assembly map name (e.g. GCA_000003195.3). Matches maps._id in MongoDB."
        },
        capabilities: {
          type: "string[]",
          description: "Multi-valued tag listing what data is available on the gene. Use as a fast pre-filter before expensive ancestor or facet queries. Vocabulary observed in production: 'location', 'pubs' (literature xrefs), 'taxonomy', 'xrefs', 'expression' (has *__expr / l2fc / pval Solr fields), 'familyRoot', 'homology' (Compara gene tree), 'domains' (InterPro), 'GO', 'PO', 'TO', 'pathways' (Plant Reactome), 'Grassius', 'MAKER', 'QTL_TO' (gene falls inside a curated QTL), 'VEP' (predicted loss-of-function germplasm). Examples: fq=['capabilities:expression'] (only genes with RNA-seq data); fq=['capabilities:VEP','taxonomy__ancestors:4558'] (sorghum genes with VEP coverage)."
        },
        // Literature cross-references
        "PUBMED__xrefs": {
          type: "string[]",
          description: "PubMed cross-references for this gene. Values are PMID strings (e.g. '31597271') or DOI strings prefixed with 'DOI:' (e.g. 'DOI:10.1016/j.cj.2016.06.014'). Only present on genes with capabilities:pubs. Use the pubmed_for_genes tool to collect PMID/DOI lists for a set of genes; resolve those IDs to bibliographic detail via a PubMed-focused MCP."
        },
        "GenBank__xrefs": {
          type: "string[]",
          description: "GenBank protein accession cross-references (e.g. 'EES10882')."
        },
        // VEP (Variant Effect Prediction) loss-of-function fields
        // Field name encoding: VEP__{consequence}__{zygosity}__{species}__{study_id}__attr_ss
        // Merged totals:       VEP__merged__{EMS|NAT}__attr_ss
        "VEP__*__attr_ss": {
          type: "string[]",
          dynamicField: true,
          description: "Ensembl VEP predicted loss-of-function alleles. Each field name encodes the consequence (e.g. stop_gained, splice_acceptor_variant), zygosity (het/homo), species (e.g. sorghum_bicolor), and study_id. Values are germplasm ens_id strings. Use the vep_for_gene tool to retrieve and decode these fields with full germplasm metadata."
        },
        "VEP__merged__EMS__attr_ss": {
          type: "string[]",
          description: "Union of all EMS (ethyl-methanesulfonate) mutagenesis germplasm with any LOF allele in this gene. Useful for counting total EMS knockout lines."
        },
        "VEP__merged__NAT__attr_ss": {
          type: "string[]",
          description: "Union of all natural diversity germplasm with any LOF allele in this gene. Useful for counting total natural accessions with LOF variants."
        }
      }
    },
    suggestions: {
      core: SOLR_SUGGESTIONS_CORE,
      endpoint: "select",
      queryPattern: "{!boost b=relevance}name:<t>^5 ids:<t>^5 ids:<t>*^3 synonym:<t>^3 synonym:<t>*^2 text:<t>*^1",
      fields: {
        name:      { type: "string",  description: "Gene or feature name" },
        ids:       { type: "string",  description: "Gene/feature identifiers" },
        synonym:   { type: "string",  description: "Synonyms and aliases" },
        text:      { type: "string",  description: "Full-text search field" },
        relevance: { type: "float",   description: "Boost score used by {!boost b=relevance}" },
        fq_field:  { type: "string",  description: "Solr field name to use as filter in genes core" },
        fq_value:  { type: "string|int", description: "Value to filter on in genes core" }
      }
    }
  },
  mongo: {
    collections: {
      taxonomy: { key: "_id", type: "int", labelField: "name",
        description: "NCBI taxonomy nodes. _id = taxon_id integer." },
      GO: { key: "_id", type: "int", labelField: "name",
        description: "Gene Ontology terms. _id = integer part of GO:XXXXXXX. Has 'ancestors' int[] field." },
      PO: { key: "_id", type: "int", labelField: "name",
        description: "Plant Ontology terms. _id = integer part of PO:XXXXXXX. Has 'ancestors' int[] field." },
      TO: { key: "_id", type: "int", labelField: "name",
        description: "Trait Ontology terms. _id = integer part of TO:XXXXXXX. Has 'ancestors' int[] field. Use to find trait-relevant terms for QTL scoring." },
      domains: { key: "_id", type: "int", labelField: "name",
        description: "Protein domain definitions." },
      pathways: { key: "_id", type: "int", labelField: "name",
        description: "Pathway definitions." },
      genes: { key: "_id", type: "string", labelField: "name",
        description: "Gene metadata. _id = gene stable ID. Has location {region, start, end, strand, map}, xrefs, biotype, taxon_id, system_name, gene_idx. Homology subdocument: homology.gene_tree = {id, representative: {closest: {id, description, percent_identity, taxon_id}, model: {...}}, root_taxon_id}. Homology.homologous_genes mirrors the Solr homology__* fields keyed by relationship type (ortholog_one2one, ortholog_one2many, ortholog_many2many, within_species_paralog, gene_split), each containing an array of {id, system_name, ...} objects." },
      genetree: { key: "_id", type: "string",
        description: "Compara gene trees. _id = tree stable ID (e.g. SB10GT_332720). Hierarchical node structure with taxon_id, node_type, children." },
      qtls: { key: "_id", type: "string",
        description: "QTL records. _id = QTL identifier. Has location {map, region, start, end}, source, description, and terms[] (TO term IDs like 'TO:0000396'). Use to find QTL intervals for a trait." },
      experiments: { key: "_id", type: "string",
        description: "Expression experiment metadata. _id = experiment accession (e.g. E-MTAB-5956). Has type ('Baseline'|'Differential'), taxon_id, name, description, factors[]." },
      assays: { key: "_id", type: "string",
        description: "Assay group metadata. _id = '{experiment}.{group}'. Has characteristic[] and factor[] arrays with {type, label, ontology?, id?, int_id?}. The int_id is the integer PO/EFO term ID for filtering by tissue or condition." },
      expression: { key: "_id", type: "string",
        description: "Expression values per gene. _id = gene stable ID. Dynamic keys are experiment accessions; values are arrays of {group, value} (Baseline: TPM/FPKM) or {group, l2fc, p_value} (Differential). Use expression_for_genes tool to join with assay/experiment metadata." },
      maps: { key: "_id", type: "string",
        description: "Genome assembly metadata. _id = assembly map name (e.g. GCA_000003195.3), matching the 'map' field in the Solr genes core. Key field: in_compara (boolean) — true if this genome was included in the Compara gene tree analysis and therefore has homology/PAV data. Use this to distinguish genomes with homology info from those without before interpreting PAV/CNV facet results." },
      germplasm: { key: "_id", type: "string",
        description: "Germplasm accession metadata. _id = germplasm ens_id (e.g. 'SGT_PI514460', 'ARS105') matching values in VEP__* Solr fields. Fields: pub_id (public accession name/ID), stock_center (genebank code: ARS, IRRI, ICRISAT, sorbmutdb, NCBI, etc.), germplasm_dbid (numeric ID for stock center hyperlink), subpop (subpopulation classification), pop_id (study ID matching VEP field name). Used by vep_for_gene to enrich germplasm IDs with links and metadata." },
    }
  }
};

// --- Solr helpers ---
function solrUrl(core, endpoint, params) {
  const base = SOLR_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/${encodeURIComponent(core)}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  url.searchParams.set("wt", "json");
  return url.toString();
}

async function solrFetch(core, endpoint, args) {
  const {
    q,
    fq,
    fl,
    rows = 10,
    start = 0,
    sort,
    defType,
    facet,
    stats,
  } = args || {};

  if (!q || typeof q !== "string") {
    throw new Error(`Solr ${endpoint} requires a non-empty string 'q'`);
  }

  // Classic Solr field faceting — expand the 'facet' convenience object into
  // individual URL params (facet=true, facet.field=X, facet.pivot=A,B, etc.)
  const facetParams = {};
  if (facet) {
    facetParams["facet"] = "true";
    if (facet.field) {
      facetParams["facet.field"] = Array.isArray(facet.field) ? facet.field : [facet.field];
    }
    if (facet.mincount !== undefined) facetParams["facet.mincount"] = String(facet.mincount);
    if (facet.limit    !== undefined) facetParams["facet.limit"]    = String(facet.limit);
    if (facet.missing  !== undefined) facetParams["facet.missing"]  = facet.missing ? "true" : "false";
    // Pivot faceting: facet.pivot=field1,field2 gives nested counts.
    // Pass a comma-separated string (one pivot) or array of strings (multiple pivots).
    if (facet.pivot) {
      facetParams["facet.pivot"] = Array.isArray(facet.pivot) ? facet.pivot : [facet.pivot];
    }
    if (facet.pivot_mincount !== undefined) facetParams["facet.pivot.mincount"] = String(facet.pivot_mincount);
    // Range faceting: distribute numeric values into fixed-width buckets.
    // facet.range = { field, start, end, gap, include?, other?, hardend? }
    // Returns facet_counts.facet_ranges.<field>.counts as [bucket_start, count, ...]
    if (facet.range) {
      const ranges = Array.isArray(facet.range) ? facet.range : [facet.range];
      for (const r of ranges) {
        if (!r.field) continue;
        facetParams["facet.range"]            = [...(facetParams["facet.range"] || []), r.field];
        facetParams[`f.${r.field}.facet.range.start`] = String(r.start ?? 0);
        facetParams[`f.${r.field}.facet.range.end`]   = String(r.end);
        facetParams[`f.${r.field}.facet.range.gap`]   = String(r.gap);
        if (r.include) facetParams[`f.${r.field}.facet.range.include`] = r.include;
        if (r.other)   facetParams[`f.${r.field}.facet.range.other`]   = r.other;
        if (r.hardend !== undefined) facetParams[`f.${r.field}.facet.range.hardend`] = r.hardend ? "true" : "false";
      }
    }
  }

  // Solr field statistics: min, max, sum, mean, stddev, percentiles, count, missing.
  // stats = { field: "field_name" } or { field: ["f1","f2"], percentiles: "25,50,75,95" }
  const statsParams = {};
  if (stats) {
    statsParams["stats"] = "true";
    const fields = Array.isArray(stats.field) ? stats.field : [stats.field];
    statsParams["stats.field"] = fields;
    if (stats.percentiles) {
      // Apply percentile config to each field
      for (const f of fields) {
        statsParams[`f.${f}.stats.percentiles`] = String(stats.percentiles);
      }
    }
  }

  const url = solrUrl(core, endpoint, { q, fq, fl, rows, start, sort, defType, ...facetParams, ...statsParams });
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Solr HTTP ${r.status}: ${txt || r.statusText}`);
  }
  return r.json();
}

function solrEscapeValue(v) {
  // Wraps value in quotes for use in fq clauses (field:"value").
  // Safe for spaces and special chars; fine for numeric IDs too.
  const s = String(v);
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function solrEscapeTerm(term) {
  // Escapes special Solr characters WITHOUT quoting, so the result can be
  // used in field:value and field:value* (wildcard) query clauses.
  return String(term).replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}

// Build the standard Gramene suggest boost query for a search term.
// Matches the live query pattern used at data.sorghumbase.org:
//   {!boost b=relevance}name:<t>^5 ids:<t>^5 ids:<t>*^3 synonym:<t>^3 synonym:<t>*^2 text:<t>*^1
function buildSuggestQuery(term) {
  const t = solrEscapeTerm(term);
  return (
    `{!boost b=relevance}` +
    `name:${t}^5 ` +
    `ids:${t}^5 ` +
    `ids:${t}*^3 ` +
    `synonym:${t}^3 ` +
    `synonym:${t}*^2 ` +
    `text:${t}*^1`
  );
}

function compileBoolFilter(node) {
  if (!node || typeof node !== "object") throw new Error("filter must be an object");

  // term node: { term: { field, value } }
  if (node.term) {
    const { field, value } = node.term;
    if (!field || value === undefined) throw new Error("term requires field and value");
    // If you know values are numeric IDs you can skip quoting; quoting is safer universally.
    return `(${field}:${solrEscapeValue(value)})`;
  }

  // op node: { op: "AND"|"OR"|"NOT", args: [...] }
  const op = String(node.op || "").toUpperCase();
  const args = Array.isArray(node.args) ? node.args : [];
  if (!["AND", "OR", "NOT"].includes(op)) throw new Error(`Unknown op: ${op}`);
  if (args.length === 0) throw new Error(`${op} requires args`);

  if (op === "NOT") {
    if (args.length !== 1) throw new Error("NOT requires exactly 1 arg");
    return `(NOT ${compileBoolFilter(args[0])})`;
  }

  // AND/OR
  const compiled = args.map(compileBoolFilter);
  return `(${compiled.join(` ${op} `)})`;
}

// --- MongoDB safety ---
const BLOCKED_MONGO_OPS = new Set(["$where", "$accumulator", "$function"]);

function sanitizeFilter(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeFilter);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (BLOCKED_MONGO_OPS.has(k)) {
      throw new Error(`Operator '${k}' is not allowed in filters`);
    }
    out[k] = sanitizeFilter(v);
  }
  return out;
}

// Compile a Solr {!graph} local-params query string from structured inputs.
// Produces e.g.: {!graph from=compara_neighbors_10 to=compara_idx_multi maxDepth=1}gene_tree:X
//
// maxDepth is hard-coded to 1. Deeper traversals on the genes core are
// expensive and have proven error-prone in practice. Multi-hop relationships
// are expressed by chaining two graph queries (e.g. orthologs → neighbors)
// rather than by raising the depth.
function compileGraphQuery(from, to, seedQuery, opts = {}) {
  if (!from || !to || !seedQuery) {
    throw new Error("graph query requires 'from', 'to', and 'seed_q'");
  }
  const localParams = { from, to, maxDepth: 1 };
  if (opts.traversalFilter) {
    // Wrap in quotes if it contains spaces
    const tf = String(opts.traversalFilter);
    localParams.traversalFilter = tf.includes(" ") ? `"${tf.replace(/"/g, '\\"')}"` : tf;
  }
  if (opts.returnRoot !== undefined) localParams.returnRoot = !!opts.returnRoot;

  const lp = Object.entries(localParams)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  return `{!graph ${lp}}${seedQuery}`;
}

// --- Tool implementations ---

async function tool_genes_in_region(args) {
  const { region, start, end, taxon_id, map: mapFilter, fl, rows = 200, sort } = args || {};
  if (!region || start === undefined || end === undefined) {
    throw new Error("genes_in_region requires 'region', 'start', and 'end'");
  }
  // Return genes whose coordinates overlap [start, end]:
  //   gene.start <= region_end  AND  gene.end >= region_start
  const q = `region:${solrEscapeValue(String(region))}`;
  const fq = [
    `start:[* TO ${Number(end)}]`,
    `end:[${Number(start)} TO *]`,
  ];
  // Apply species filter via taxonomy__ancestors (plain NCBI taxon ID).
  // This matches all subspecies/assemblies under that taxon and avoids the
  // NCBI×1000+suffix encoding required by the Solr `taxon_id` field.
  if (taxon_id !== undefined) fq.push(`taxonomy__ancestors:${Number(taxon_id)}`);
  if (mapFilter) fq.push(`map:${solrEscapeValue(mapFilter)}`);
  return solrFetch(SOLR_GENES_CORE, "select", { q, fq, fl, rows, sort });
}

// Solr field names encode experiment IDs by replacing each '-' with '_':
//   E_GEOD_98817_g4__expr             → experiment "E-GEOD-98817", group "g4"
//   E_GEOD_54705_g5_g7_l2fc_attr_f    → experiment "E-GEOD-54705", contrast g5→g7
// Recover the original experiment ID by re-joining the leading underscore-
// separated tokens with dashes, stopping at the first group token "gN".
function parseBaselineField(field) {
  // strip "__expr" suffix → "<E_…>_g<N>"
  if (!field.endsWith("__expr")) return null;
  const stem = field.slice(0, -"__expr".length);
  const parts = stem.split("_");
  // group token is the trailing "gN"
  const groupIdx = parts.length - 1;
  if (!/^g\d+$/.test(parts[groupIdx])) return null;
  return {
    experiment: parts.slice(0, groupIdx).join("-"),
    group: parts[groupIdx],
  };
}

function parseDifferentialField(field) {
  // strip "_l2fc_attr_f" or "_pval_attr_f" suffix → "<E_…>_gC_gT"
  let metric;
  let stem;
  if (field.endsWith("_l2fc_attr_f")) { metric = "l2fc"; stem = field.slice(0, -"_l2fc_attr_f".length); }
  else if (field.endsWith("_pval_attr_f")) { metric = "p_value"; stem = field.slice(0, -"_pval_attr_f".length); }
  else return null;

  const parts = stem.split("_");
  if (parts.length < 3) return null;
  const treatmentIdx = parts.length - 1;
  const controlIdx   = parts.length - 2;
  if (!/^g\d+$/.test(parts[controlIdx]) || !/^g\d+$/.test(parts[treatmentIdx])) return null;
  return {
    experiment: parts.slice(0, controlIdx).join("-"),
    control_group:   parts[controlIdx],
    treatment_group: parts[treatmentIdx],
    metric,
  };
}

// Tissue extraction for an assay document (factor preferred over characteristic).
function assayTissue(assay) {
  if (!assay) return null;
  return (
    assay.factor?.find((f) => f.type === "organism part")?.label ??
    assay.characteristic?.find((c) => c.type === "organism part")?.label ??
    null
  );
}

// All PO int_ids attached to an assay (factor and characteristic).
function assayPoIds(assay) {
  const ids = new Set();
  for (const list of [assay?.factor, assay?.characteristic]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) if (typeof f?.int_id === "number") ids.add(f.int_id);
  }
  return ids;
}

// Compute the contrast: factors whose values differ between control and
// treatment assays. Each entry is { type, control, treatment }. Factor types
// shared across both with identical values are reported as `shared_factors`.
function diffAssayFactors(controlAssay, treatmentAssay) {
  const cFactors = controlAssay?.factor   || [];
  const tFactors = treatmentAssay?.factor || [];
  const types = new Set([
    ...cFactors.map((f) => f.type),
    ...tFactors.map((f) => f.type),
  ]);
  const contrast = [];
  const shared = [];
  for (const type of types) {
    const c = cFactors.find((f) => f.type === type)?.label ?? null;
    const t = tFactors.find((f) => f.type === type)?.label ?? null;
    if (c === t) shared.push({ type, label: c });
    else contrast.push({ type, control: c, treatment: t });
  }
  return { contrast, shared };
}

async function tool_expression_for_genes(args) {
  const {
    gene_ids,
    experiment_type,  // "Baseline" | "Differential" | undefined (both)
    taxon_id,         // integer — filter experiments by species (the species the experiment was done in)
    po_terms,         // int[] — PO term int_ids; either control or treatment assay must match
  } = args || {};

  if (!Array.isArray(gene_ids) || gene_ids.length === 0) {
    throw new Error("expression_for_genes requires a non-empty 'gene_ids' array");
  }
  if (gene_ids.length > 500) {
    throw new Error("expression_for_genes: max 500 gene_ids per call");
  }

  const wantBaseline     = !experiment_type || experiment_type === "Baseline";
  const wantDifferential = !experiment_type || experiment_type === "Differential";

  // 1. Determine the experiments allowed by the type/taxon filters from cache.
  const allowedExperiments = new Set();
  for (const exp of cacheValues("experiments")) {
    if (experiment_type && exp.type !== experiment_type) continue;
    if (taxon_id !== undefined && Number(exp.taxon_id) !== Number(taxon_id)) continue;
    allowedExperiments.add(exp._id);
  }

  // 2. PO term expansion against the cached PO ontology. If callers passed PO
  //    ints, expand to ancestors so the row-level filter below treats both the
  //    requested terms and their ancestors as "matching tissues".
  const poInfo = { requested: null, expanded: false, ancestors_used: [] };
  let allowedPoIds = null;            // null = no PO filter
  let strictPoIds  = null;            // user-requested ints only (without ancestors)
  if (po_terms && po_terms.length > 0) {
    strictPoIds  = new Set(po_terms.map(Number));
    poInfo.requested = [...strictPoIds];
    allowedPoIds = new Set(strictPoIds);
    // We always include ancestors up-front so the per-row filter is single-pass;
    // poInfo.expanded gets flipped below if no row matched the strict set.
    for (const id of strictPoIds) {
      const poDoc = cacheGet("PO", id);
      if (Array.isArray(poDoc?.ancestors)) {
        for (const a of poDoc.ancestors) if (!strictPoIds.has(a)) {
          allowedPoIds.add(a);
          poInfo.ancestors_used.push(a);
        }
      }
    }
  }

  // 3. Build the Solr fl wildcard list according to which experiment types are
  //    requested, then fetch the gene docs in a single round-trip.
  const flParts = ["id", "name", "description", "expressed_in_gxa_attr_ss"];
  if (wantBaseline)     flParts.push("*__expr");
  if (wantDifferential) flParts.push("*_l2fc_attr_f", "*_pval_attr_f");
  const idQuery = `id:(${gene_ids.join(" OR ")})`;
  const solrResp = await solrFetch(SOLR_GENES_CORE, "query", {
    q: idQuery,
    fq: ["capabilities:expression"],
    fl: flParts.join(","),
    rows: gene_ids.length,
    defType: "lucene",
  });
  const docs = solrResp?.response?.docs || [];

  // 4. Walk each gene doc, parse expression field names, join with cached
  //    experiment + assay metadata.
  const genes = {};
  let strictMatchedAny = false;       // tracks whether any baseline OR differential row passed the strict PO filter

  for (const doc of docs) {
    const baseline = [];
    const differential = [];

    // Baseline: one field per (experiment, group)
    if (wantBaseline) {
      for (const [field, value] of Object.entries(doc)) {
        if (!field.endsWith("__expr") || value == null) continue;
        const parsed = parseBaselineField(field);
        if (!parsed) continue;
        if (!allowedExperiments.has(parsed.experiment)) continue;
        const assay = cacheGet("assays", `${parsed.experiment}.${parsed.group}`);
        const poIds = assayPoIds(assay);
        if (allowedPoIds) {
          let matched = false;
          for (const id of poIds) if (allowedPoIds.has(id)) { matched = true; break; }
          if (!matched) continue;
          if (!strictMatchedAny) {
            for (const id of poIds) if (strictPoIds.has(id)) { strictMatchedAny = true; break; }
          }
        }
        const exp = cacheGet("experiments", parsed.experiment);
        baseline.push({
          experiment:      parsed.experiment,
          experiment_name: exp?.name ?? null,
          group:           parsed.group,
          value,
          tissue:          assayTissue(assay),
          factors:         assay?.factor ?? [],
        });
      }
    }

    // Differential: pair _l2fc with the matching _pval by stem identity
    if (wantDifferential) {
      const contrasts = new Map();    // key: "<exp>__<cg>__<tg>"
      for (const [field, value] of Object.entries(doc)) {
        const parsed = parseDifferentialField(field);
        if (!parsed || value == null) continue;
        if (!allowedExperiments.has(parsed.experiment)) continue;
        const key = `${parsed.experiment}__${parsed.control_group}__${parsed.treatment_group}`;
        const slot = contrasts.get(key) || {
          experiment:      parsed.experiment,
          control_group:   parsed.control_group,
          treatment_group: parsed.treatment_group,
        };
        slot[parsed.metric] = value;
        contrasts.set(key, slot);
      }
      for (const slot of contrasts.values()) {
        const cAssay = cacheGet("assays", `${slot.experiment}.${slot.control_group}`);
        const tAssay = cacheGet("assays", `${slot.experiment}.${slot.treatment_group}`);
        // PO filter: either control or treatment assay must match an allowed PO id
        if (allowedPoIds) {
          const cIds = assayPoIds(cAssay);
          const tIds = assayPoIds(tAssay);
          let matched = false;
          for (const id of cIds) if (allowedPoIds.has(id)) { matched = true; break; }
          if (!matched) for (const id of tIds) if (allowedPoIds.has(id)) { matched = true; break; }
          if (!matched) continue;
          if (!strictMatchedAny) {
            for (const id of cIds) if (strictPoIds.has(id)) { strictMatchedAny = true; break; }
            if (!strictMatchedAny) for (const id of tIds) if (strictPoIds.has(id)) { strictMatchedAny = true; break; }
          }
        }
        const exp = cacheGet("experiments", slot.experiment);
        const { contrast, shared } = diffAssayFactors(cAssay, tAssay);
        differential.push({
          experiment:      slot.experiment,
          experiment_name: exp?.name ?? null,
          control_group:   slot.control_group,
          treatment_group: slot.treatment_group,
          control_tissue:    assayTissue(cAssay),
          treatment_tissue:  assayTissue(tAssay),
          control_factors:   cAssay?.factor ?? [],
          treatment_factors: tAssay?.factor ?? [],
          contrast,
          shared_factors: shared,
          l2fc:    slot.l2fc    ?? null,
          p_value: slot.p_value ?? null,
        });
      }
    }

    genes[doc.id] = {
      name: doc.name ?? null,
      description: doc.description ?? null,
      experiments_with_data: doc.expressed_in_gxa_attr_ss ?? [],
      baseline,
      differential,
    };
  }

  // Fill in entries for requested gene_ids that returned no Solr doc (no
  // expression data, or filtered out by capabilities:expression).
  for (const gid of gene_ids) {
    if (!genes[gid]) {
      genes[gid] = {
        name: null,
        description: null,
        experiments_with_data: [],
        baseline: [],
        differential: [],
      };
    }
  }

  // If the PO filter is active and produced rows, but only via ancestor
  // expansion, mark expanded:true. If no row matched even with ancestors, the
  // result is just empty — which the caller sees from the empty arrays.
  if (allowedPoIds && !strictMatchedAny) {
    const anyMatched = Object.values(genes).some(
      (g) => g.baseline.length || g.differential.length
    );
    if (anyMatched) poInfo.expanded = true;
  }

  const result = {
    gene_count:       gene_ids.length,
    experiment_count: allowedExperiments.size,
    genes,
  };
  if (po_terms && po_terms.length > 0) result.po_filter = poInfo;
  return result;
}

// --- VEP (Variant Effect Prediction) tool ---

// Study/population metadata keyed by species → study_id
// Derived from Gramene/SorghumBase front-end VEP.js
const VEP_STUDY_INFO = {
  sorghum_bicolor: {
    "1": { label: "Purdue EMS",              type: "EMS" },
    "2": { label: "USDA Lubbock EMS",        type: "EMS" },
    "3": { label: "Lozano",                  type: "NAT" },
    "4": { label: "USDA Lubbock EMS",        type: "EMS" },
    "5": { label: "Boatwright SAP",          type: "NAT" },
    "7": { label: "Kumar BAP",               type: "NAT" },
    "8": { label: "Lasky landraces",         type: "NAT" },
    "9": { label: "Sorghum Genomics Toolbox",type: "NAT" },
  },
  zea_maysb73: {
    "15": { label: "MaizeGDB 2024",          type: "NAT" },
  },
  oryza_sativa: {
    "7":  { label: "Rice 3K",                type: "NAT" },
    "20": { label: "19K-RGP",               type: "NAT" },
    "29": { label: "Rice USDA mini core",    type: "NAT" },
    "38": { label: "RAPDB 2024",             type: "NAT" },
  },
  oryza_aus:           { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativa117425:  { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativair64rs2: { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativamh63:    { "20": { label: "19K-RGP", type: "NAT" } },
};

// Stock-center genebank URL templates
const VEP_GENEBANK_URLS = {
  ARS:      "https://npgsweb.ars-grin.gov/gringlobal/accessiondetail.aspx?id=",
  IRRI:     "https://www.irri.org/genesys-rice#/a/",
  xIRRI:    "https://gringlobal.irri.org/gringlobal/accessiondetail?id=",
  ICRISAT:  "https://genebank.icrisat.org/IND/PassportSummary?ID=",
  sorbmutdb:"https://www.depts.ttu.edu/igcast/sorbmutdb.php",
  maizeGDB: "https://wgs.maizegdb.org/",
  NCBI:     "https://www.ncbi.nlm.nih.gov/biosample/?term=",
};

/**
 * Parse a VEP__ Solr dynamic field name into its semantic parts.
 * Returns null for unknown/malformed names.
 * Regular:  VEP__{consequence}__{zygosity}__{species}__{study_id}__attr_ss
 * Merged:   VEP__merged__{type}__attr_ss
 */
function parseVepFieldName(fieldName) {
  if (!fieldName.startsWith("VEP__")) return null;
  const parts = fieldName.split("__");
  // parts[0] = "VEP", last = "attr_ss"
  if (parts[1] === "merged") {
    // VEP__merged__{EMS|NAT}__attr_ss
    return { merged: true, type: parts[2] };
  }
  if (parts.length >= 6) {
    const [, consequence, zygosity, species, study_id] = parts;
    const studyMap = VEP_STUDY_INFO[species] || {};
    const studyInfo = studyMap[study_id] || { label: `Study ${study_id}`, type: "unknown" };
    return {
      merged: false,
      consequence: consequence.replaceAll("_", " "),
      zygosity: zygosity === "het" ? "heterozygous" : "homozygous",
      species,
      study_id,
      study_label: studyInfo.label,
      study_type: studyInfo.type,
    };
  }
  return null;
}

async function tool_vep_for_gene(args) {
  const { gene_ids, include_germplasm_details = true } = args || {};
  if (!Array.isArray(gene_ids) || gene_ids.length === 0) {
    throw new Error("vep_for_gene requires a non-empty 'gene_ids' array");
  }
  if (gene_ids.length > 50) {
    throw new Error("vep_for_gene: max 50 gene_ids per call");
  }

  // 1. Fetch VEP__ dynamic fields from Solr
  const q = gene_ids.length === 1
    ? `id:${gene_ids[0]}`
    : `id:(${gene_ids.join(" OR ")})`;
  const solrResp = await solrFetch(SOLR_GENES_CORE, "select", {
    q,
    fl: "id,VEP__*",
    rows: gene_ids.length,
  });

  const solrDocs = solrResp?.response?.docs ?? [];

  // 2. Collect all germplasm ens_ids across all genes (for MongoDB lookup)
  const allEnsIds = new Set();
  for (const doc of solrDocs) {
    for (const [field, values] of Object.entries(doc)) {
      if (field.startsWith("VEP__") && Array.isArray(values)) {
        values.forEach((v) => allEnsIds.add(v));
      }
    }
  }

  // 3. Look up germplasm metadata from MongoDB (if any IDs found)
  let germplasmMap = {};  // ens_id → germplasm doc
  if (allEnsIds.size > 0 && include_germplasm_details) {
    const d = db();
    const germDocs = await d.collection("germplasm")
      .find({ _id: { $in: [...allEnsIds] } })
      .toArray();
    for (const g of germDocs) {
      germplasmMap[g._id] = g;
    }
  }

  // 4. Build structured result per gene
  const result = {};
  for (const doc of solrDocs) {
    const geneId = doc.id;
    const groups = [];
    let emsTotal = 0, natTotal = 0;

    for (const [field, values] of Object.entries(doc)) {
      if (!field.startsWith("VEP__") || !Array.isArray(values)) continue;
      const parsed = parseVepFieldName(field);
      if (!parsed) continue;

      if (parsed.merged) {
        // Merged totals for summary
        if (parsed.type === "EMS") emsTotal = values.length;
        else if (parsed.type === "NAT") natTotal = values.length;
        continue;
      }

      // Enrich with germplasm metadata when available
      const accessions = values.map((ens_id) => {
        const g = germplasmMap[ens_id];
        if (!g) return { ens_id };
        const entry = { ens_id, pub_id: g.pub_id, stock_center: g.stock_center };
        if (g.germplasm_dbid && g.germplasm_dbid !== "0") {
          const url = VEP_GENEBANK_URLS[g.stock_center];
          if (url) entry.genebank_url = `${url}${g.germplasm_dbid}`;
        }
        if (g.subpop && g.subpop !== "?") entry.subpopulation = g.subpop;
        return entry;
      });

      groups.push({
        consequence:  parsed.consequence,
        zygosity:     parsed.zygosity,
        species:      parsed.species,
        study_label:  parsed.study_label,
        study_type:   parsed.study_type,
        count:        accessions.length,
        accessions,
      });
    }

    // Sort groups: EMS first, then by consequence, then zygosity
    groups.sort((a, b) => {
      const typeOrd = (a.study_type === "EMS" ? 0 : 1) - (b.study_type === "EMS" ? 0 : 1);
      if (typeOrd !== 0) return typeOrd;
      return a.consequence.localeCompare(b.consequence) || a.zygosity.localeCompare(b.zygosity);
    });

    result[geneId] = {
      summary: {
        total_lof_accessions: emsTotal + natTotal,
        ems_accessions: emsTotal,
        nat_accessions: natTotal,
        group_count: groups.length,
        germplasm_metadata_available: Object.keys(germplasmMap).length > 0,
      },
      groups,
    };
  }

  // Note any requested genes with no VEP data
  for (const gid of gene_ids) {
    if (!result[gid]) {
      result[gid] = { summary: { total_lof_accessions: 0, note: "no VEP data in index" }, groups: [] };
    }
  }

  return { gene_count: Object.keys(result).length, genes: result };
}

// Enrichment analysis is intentionally NOT exposed as an MCP tool. It is
// implemented as a client-side skill that operates on (ontology, foreground
// term-frequency array, background term-frequency array). The MCP server's
// job ends with returning facet-count arrays via solr_search.


// --- PubMed cross-reference lookup ---
//
// This tool returns the PMID and DOI cross-references stored on each gene
// document in the Solr genes index. It does NOT call NCBI E-utilities to
// resolve those IDs into paper metadata (title, authors, journal, abstract).
// Resolving PubMed IDs into bibliographic records is the job of a separate,
// PubMed-focused MCP server — feed this tool's output into that one.

async function tool_pubmed_for_genes(args) {
  const { gene_ids } = args || {};
  if (!gene_ids || !gene_ids.length) {
    throw Object.assign(new Error("gene_ids is required (non-empty array)"), { code: -32602 });
  }
  if (gene_ids.length > 500) {
    throw Object.assign(new Error("gene_ids limited to 500"), { code: -32602 });
  }

  // Fetch PUBMED__xrefs from Solr, restricted to genes flagged with publications.
  const idList = gene_ids.join(" OR ");
  const solrResult = await solrFetch(SOLR_GENES_CORE, "query", {
    q: `id:(${idList})`,
    fq: ["capabilities:pubs"],
    fl: "id,name,description,PUBMED__xrefs",
    rows: gene_ids.length,
    defType: "lucene",
  });
  const docs = solrResult?.response?.docs || [];

  // Index Solr results so missing genes can be filled with empty entries below.
  const docMap = Object.fromEntries(docs.map((d) => [d.id, d]));
  const allPmids = new Set();
  const allDois = new Set();

  const genes = {};
  let genesWithRefs = 0;

  for (const geneId of gene_ids) {
    const doc = docMap[geneId];
    if (!doc) {
      genes[geneId] = { name: null, description: null, pmids: [], dois: [], count: 0 };
      continue;
    }
    const refs = doc.PUBMED__xrefs || [];
    const pmids = [];
    const dois = [];
    for (const ref of refs) {
      if (ref.startsWith("DOI:")) {
        const doi = ref.slice(4);
        dois.push(doi);
        allDois.add(doi);
      } else if (/^\d+$/.test(ref)) {
        pmids.push(ref);
        allPmids.add(ref);
      }
    }
    const count = pmids.length + dois.length;
    if (count > 0) genesWithRefs++;
    genes[geneId] = {
      name: doc.name || null,
      description: doc.description || null,
      pmids,
      dois,
      count,
    };
  }

  return {
    gene_count: gene_ids.length,
    genes_with_refs: genesWithRefs,
    total_unique_pmids: allPmids.size,
    total_unique_dois: allDois.size,
    genes,
  };
}

async function tool_solr_search(args) {
  return solrFetch(SOLR_GENES_CORE, "query", args);
}

async function tool_solr_suggest(args) {
  const { term, q, fq, fl, rows = 10, start = 0, sort } = args || {};
  // 'term' auto-builds the standard Gramene boosted query across name/ids/synonym/text.
  // 'q' allows a raw Solr query string for advanced use. 'term' takes precedence.
  const query = term ? buildSuggestQuery(term) : q;
  if (!query) throw new Error("solr_suggest requires 'term' or 'q'");
  return solrFetch(SOLR_SUGGESTIONS_CORE, "select", { q: query, fq, fl, rows, start, sort });
}

async function tool_solr_search_bool(args) {
  const {
    q = "*:*",
    filter,
    fl,
    rows = 10,
    start = 0,
    sort,
    defType,
    extra_fq,
  } = args || {};

  const fq = [];
  if (filter) fq.push(compileBoolFilter(filter));
  if (Array.isArray(extra_fq)) fq.push(...extra_fq);

  return solrFetch(SOLR_GENES_CORE, "select", {
    q, fq: fq.length ? fq : undefined, fl, rows, start, sort, defType,
  });
}

async function tool_solr_graph(args) {
  const {
    from,
    to,
    seed_q,
    traversalFilter,
    returnRoot = true,
    fq,
    fl,
    rows = 100,
    start = 0,
    sort,
  } = args || {};

  const q = compileGraphQuery(from, to, seed_q, { traversalFilter, returnRoot });
  return solrFetch(SOLR_GENES_CORE, "select", { q, fq, fl, rows, start, sort });
}

async function tool_mongo_list_collections(args) {
  const { nameOnly = true } = args || {};
  const d = db();
  const items = await d.listCollections({}, { nameOnly: !!nameOnly }).toArray();
  return { count: items.length, collections: items };
}

async function tool_mongo_find(args) {
  const {
    collection,
    filter = {},
    projection,
    sort,
    limit = 50,
    skip = 0,
  } = args || {};

  if (!collection || typeof collection !== "string") {
    throw new Error("mongo_find requires string 'collection'");
  }
  if (typeof filter !== "object" || filter === null) {
    throw new Error("'filter' must be an object");
  }

  const safeFilter = sanitizeFilter(filter);
  const d = db();
  let cursor = d.collection(collection).find(
    safeFilter,
    projection ? { projection } : undefined
  );
  if (sort) cursor = cursor.sort(sort);
  cursor = cursor.skip(skip).limit(Math.min(Math.max(limit, 0), 1000));

  const docs = await cursor.toArray();
  return { count: docs.length, docs };
}

async function tool_mongo_lookup_by_ids(args) {
  const { collection, ids, projection } = args || {};
  if (!collection) throw new Error("collection required");
  if (!Array.isArray(ids)) throw new Error("ids must be an array");

  const numIds = ids.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const d = db();
  const docs = await d.collection(collection)
    .find({ _id: { $in: numIds } }, projection ? { projection } : undefined)
    .toArray();

  return { count: docs.length, docs };
}

// --- Tool registry (definition + handler in one place) ---
const SOLR_QUERY_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", description: "Solr query string" },
    fq: { type: "array", items: { type: "string" }, description: "Filter query strings" },
    fl: { type: "string", description: "Comma-separated field list to return" },
    rows: { type: "integer", minimum: 0, maximum: 1000, description: "Max documents to return (default 10)" },
    start: { type: "integer", minimum: 0, description: "Offset for pagination" },
    sort: { type: "string", description: "Sort clause, e.g. 'score desc'" },
    defType: { type: "string", description: "Query parser type, e.g. 'edismax'" },
    facet: {
      type: "object",
      description: [
        "Field facet counting. Returns facet_counts.facet_fields (flat) or facet_counts.facet_pivot (nested).",
        "Use with rows:0 to get counts without fetching documents.",
        "",
        "Flat facet — count genes per genome:",
        '  { "field": "system_name", "mincount": 1, "limit": -1 }',
        "",
        "Pivot facet — nested counts (e.g. per gene family per genome):",
        '  { "pivot": "gene_tree,system_name", "pivot_mincount": 1 }',
        "Returns facet_counts.facet_pivot['gene_tree,system_name'] — an array of",
        "{ field, value, count, pivot: [{field, value, count}, ...] } objects.",
        "",
        "Combined graph + pivot — single query for CNV across a genomic neighborhood:",
        '  q="{!graph from=compara_neighbors_10 to=compara_idx_multi}gene_tree:<id>"',
        '  fq=["taxonomy__ancestors:4558"]  // restrict to sorghum genomes',
        '  rows=0',
        '  facet={ "pivot": "gene_tree,system_name", "pivot_mincount": 1 }',
        "→ for each gene family in the region, shows copy count per genome assembly.",
        "",
        "Fields: field (string|string[]), mincount, limit, missing,",
        "        pivot (comma-separated field string or array of such strings),",
        "        pivot_mincount (int, minimum count per pivot leaf, default 1).",
      ].join("\n"),
      properties: {
        field:          { description: "Field name(s) for flat faceting. String or array of strings." },
        mincount:       { type: "integer", description: "Min count for flat facet values (0=include zeros, 1=default)" },
        limit:          { type: "integer", description: "Max flat facet values per field (-1 = unlimited)" },
        missing:        { type: "boolean", description: "Include count for documents missing this field" },
        pivot:          { description: "Pivot (nested) facet: comma-separated fields e.g. 'gene_tree,system_name'. Can also be an array for multiple independent pivots." },
        pivot_mincount: { type: "integer", description: "Min count for pivot facet leaf nodes (default 1)" },
        range: {
          description: [
            "Range facet — distributes numeric field values into equal-width buckets.",
            "Returns facet_counts.facet_ranges.<field>.counts as [bucket_start, count, ...] pairs.",
            "Use with rows:0 to get counts only.",
            "",
            "Single range example — transcript length distribution:",
            '  { "range": { "field": "transcript__length", "start": 0, "end": 20000, "gap": 500, "other": "after" } }',
            "Result: facet_counts.facet_ranges.transcript__length.counts = [0, 42, 500, 381, ...]",
            "",
            "Multiple ranges (array) — length and exon count together:",
            '  { "range": [',
            '      { "field": "transcript__length", "start": 0, "end": 30000, "gap": 1000 },',
            '      { "field": "transcript__exons",  "start": 0, "end": 50,    "gap": 1 }',
            '  ] }',
            "",
            "Fields per range object:",
            "  field    (string, required) — Solr numeric field to bucket",
            "  start    (number) — range start (default 0)",
            "  end      (number, required) — range end (exclusive)",
            "  gap      (number, required) — bucket width",
            "  other    ('before'|'after'|'between'|'none'|'all') — extra count buckets",
            "  include  ('lower'|'upper'|'edge'|'outer'|'all') — bucket boundary inclusion",
            "  hardend  (boolean) — if true, last bucket ends exactly at 'end'",
          ].join("\n"),
        },
      },
    },
    stats: {
      type: "object",
      description: [
        "Solr field statistics. Returns min, max, sum, mean, stddev, count, missing for numeric fields.",
        "Result is in response.stats.stats_fields.<field_name>.",
        "Use with rows:0 to get statistics without fetching documents.",
        "",
        "Examples:",
        '  stats: { "field": "transcript__length" }',
        '  stats: { "field": ["transcript__length", "protein__length"], "percentiles": "10,25,50,75,90,95" }',
        "",
        "Percentiles require the Solr TDigest stats component and return a map of {pct: value}.",
      ].join("\n"),
      properties: {
        field:       { description: "Field name or array of field names to compute statistics for." },
        percentiles: { type: "string", description: "Comma-separated percentile values to compute, e.g. '25,50,75,95'. Requires TDigest support." },
      },
    },
  },
  required: ["q"],
};

const TOOL_REGISTRY = {
  solr_search: {
    definition: {
      name: "solr_search",
      description: [
        `Query the Solr genes core (${SOLR_GENES_CORE}) via /query endpoint. Returns matching gene documents.`,
        `Supports field faceting (flat) and pivot faceting (nested) via the 'facet' parameter.`,
        `Use rows:0 with facets to get counts without fetching documents.`,
        ``,
        `Common uses:`,
        `  - Single-gene-by-ID: q="id:<gene_id>" with an explicit fl to build a gene card.`,
        `  - Faceted gene-family expansion: q="gene_tree:<id>" with facet.field=taxonomy__ancestors`,
        `    returns hierarchical per-clade counts, surfacing expansion/contraction.`,
        `  - Frequency arrays for client-side enrichment: facet a foreground fq and a background`,
        `    fq on the same annotation field (e.g. GO__ancestors), then run the enrichment skill.`,
        ``,
        `Useful field reference:`,
        `  expressed_in_gxa_attr_ss — array of GXA experiment accessions for the gene; joinable`,
        `    to the MongoDB experiments and assays collections.`,
        `  PUBMED__xrefs              — PubMed cross-references (use pubmed_for_genes to resolve).`,
        `  homology__ortholog_one2one / homology__all_orthologs — see orthologs_paralogs prompt.`,
        `  QTL_TO__ancestors          — QTL _ids (joinable to mongo qtls collection) for which`,
        `                               this gene falls inside the QTL interval.`,
        `  capabilities               — multi-valued tag listing what data is available on the`,
        `                               gene. Use as a fast pre-filter before expensive ancestor`,
        `                               or facet queries. Vocabulary: location, pubs, taxonomy,`,
        `                               xrefs, expression, familyRoot, homology, domains, GO,`,
        `                               PO, TO, pathways, Grassius, MAKER, QTL_TO, VEP. Example:`,
        `                               fq:["capabilities:VEP","taxonomy__ancestors:4558"] →`,
        `                               sorghum genes with VEP germplasm coverage.`,
        ``,
        `Key pattern — neighborhood CNV in a single query:`,
        `  Combine a {!graph} traversal in 'q' with facet.pivot on gene_tree,system_name.`,
        `  This expands to all genes in the ±N flanking region of every ortholog in the`,
        `  gene tree, then counts copies per gene family per genome — revealing PAV/CNV`,
        `  across an entire pangenome neighborhood in one round-trip.`,
        `  q="{!graph from=compara_neighbors_10 to=compara_idx_multi}gene_tree:<id>"`,
        `  fq=["taxonomy__ancestors:4558"], rows=0`,
        `  facet={ pivot: "gene_tree,system_name", pivot_mincount: 1 }`,
      ].join("\n"),
      inputSchema: SOLR_QUERY_SCHEMA,
    },
    handler: tool_solr_search,
  },
  solr_suggest: {
    definition: {
      name: "solr_suggest",
      description: [
        `ALWAYS START HERE for any free-text concept (gene name, family, pathway, species, ontology`,
        `term, trait). solr_suggest is the entry point for discovery — it translates a name into a`,
        `concrete fq_field + fq_value that plugs straight into solr_search. Reserve mongo_find for`,
        `fetching detail records once you already have a specific ID.`,
        ``,
        `Searches the suggestions core (${SOLR_SUGGESTIONS_CORE}) via /suggest. Pass 'term' for a`,
        `fuzzy multi-field search (auto-builds the boosted query):`,
        `  {!boost b=relevance}name:<t>^5 ids:<t>^5 ids:<t>*^3 synonym:<t>^3 synonym:<t>*^2 text:<t>*^1`,
        `Each result carries fq_field, fq_value, and num_genes (the size of the gene set that`,
        `filter would yield). Pass 'q' instead of 'term' to supply a raw Solr query.`,
        ``,
        `Choosing between results:`,
        `  - Single specific gene → highest-ranked result with fq_field=id.`,
        `  - "All X-family genes" or other broad set → pick the candidate with the LARGEST num_genes,`,
        `    not the highest-ranked. InterPro/domain matches (fq_field=domains__ancestors) often`,
        `    give the cleanest, broadest scope. Example: 'lipoxygenase' → InterPro 'LipOase' with`,
        `    fq_field=domains__ancestors covers ~1488 genes across 123 genomes.`,
        ``,
        `IMPORTANT — looking up pathways and species:`,
        `  'term' ranks across all categories and is dominated by InterPro/GO. Pathway and species`,
        `  hits often miss the top. For exact lookups, use 'q' with a field-qualified match:`,
        `    Pathway:    q='name:"Jasmonic acid biosynthesis"'  → fq_field=pathways__ancestors`,
        `    Species:    q='name:"Sorghum bicolor"'             → fq_field=taxonomy__ancestors`,
        `    TO term:    q='name:"plant height"' fq=['category:Trait Ontology']`,
        `  Then use the returned fq_field + fq_value directly as fq filters in solr_search.`,
        ``,
        `Canonical two-step pattern for "genes in pathway X in species Y":`,
        `  1. solr_suggest(q='name:"<pathway>"') → get pathways__ancestors fq_value`,
        `  2. solr_suggest(q='name:"<species>"') → get taxonomy__ancestors fq_value`,
        `  3. solr_search(fq=["pathways__ancestors:<val1>", "taxonomy__ancestors:<val2>"])`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string", description: "Search term — auto-builds the boosted query across name, ids, synonym, text fields." },
          q:    { type: "string", description: "Raw Solr query string (overridden by 'term' if both are provided)." },
          fq:   { type: "array", items: { type: "string" }, description: "Filter query strings." },
          fl:   { type: "string", description: "Comma-separated field list to return." },
          rows: { type: "integer", minimum: 0, maximum: 1000, description: "Max results to return (default 10)." },
          start: { type: "integer", minimum: 0, description: "Offset for pagination." },
          sort:  { type: "string" },
        },
      },
    },
    handler: tool_solr_suggest,
  },
  solr_search_bool: {
    definition: {
      name: "solr_search_bool",
      description: "Query the genes core using a structured boolean filter tree (AND/OR/NOT over field:value terms). Uses /select endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Solr query string (default: '*:*')" },
          filter: {
            type: "object",
            description: "Boolean expression tree. Nodes are either { term: { field, value } } or { op: 'AND'|'OR'|'NOT', args: [...] }.",
          },
          extra_fq: { type: "array", items: { type: "string" }, description: "Additional raw fq strings" },
          fl: { type: "string" },
          rows: { type: "integer", minimum: 0, maximum: 1000 },
          start: { type: "integer", minimum: 0 },
          sort: { type: "string" },
          defType: { type: "string" },
        },
      },
    },
    handler: tool_solr_search_bool,
  },
  mongo_find: {
    definition: {
      name: "mongo_find",
      description: [
        "Fetch detailed records from a MongoDB collection by a known identifier or a small structured filter.",
        "Use this AFTER you already have a specific ID — typically resolved via solr_suggest first.",
        "Do NOT use mongo_find to discover IDs from free text; that's solr_suggest's job.",
        "",
        "Common patterns:",
        "  - QTLs for a Trait Ontology term: filter:{ terms: <TO_id> } on 'qtls'",
        "  - Experiment metadata: filter:{ _id: { $in: [<exp_ids>] } } on 'experiments' or 'assays'",
        "  - Genome assembly metadata (Compara membership): filter:{ in_compara: true } on 'maps'",
        "  - Ontology term lookup by ID: prefer mongo_lookup_by_ids over an ad-hoc find().",
        "",
        "Filter parameter is `filter` (NOT `query`). Passing `query: {...}` is silently ignored.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          filter: { type: "object", description: "MongoDB query filter (default: {})" },
          projection: { type: "object", description: "Fields to include/exclude" },
          sort: { type: "object", description: "Sort specification, e.g. { name: 1 }" },
          limit: { type: "integer", minimum: 0, maximum: 1000, description: "Max docs (default 50, max 1000)" },
          skip: { type: "integer", minimum: 0 },
        },
        required: ["collection"],
      },
    },
    handler: tool_mongo_find,
  },
  mongo_list_collections: {
    definition: {
      name: "mongo_list_collections",
      description: "List all MongoDB collections in the configured database.",
      inputSchema: {
        type: "object",
        properties: {
          nameOnly: { type: "boolean", description: "Return only collection names (default: true)" },
        },
      },
    },
    handler: tool_mongo_list_collections,
  },
  mongo_lookup_by_ids: {
    definition: {
      name: "mongo_lookup_by_ids",
      description: "Fetch documents by numeric _id from a MongoDB collection. Useful for resolving Solr ancestor IDs to their labels.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          ids: { type: "array", items: { type: "number" }, description: "Array of numeric _id values" },
          projection: { type: "object" },
        },
        required: ["collection", "ids"],
      },
    },
    handler: tool_mongo_lookup_by_ids,
  },
  solr_graph: {
    definition: {
      name: "solr_graph",
      description: [
        `Traverse a single hop of a gene-relationship graph in the Solr genes core via {!graph}.`,
        `Each document carries a node-ID field ('to') and an adjacency-list field ('from')`,
        `pointing to related documents. The traversal starts from a seed query and returns its`,
        `direct neighbors. Multi-hop relationships are expressed by chaining two graph queries,`,
        `not by raising the depth.`,
        ``,
        `Common field pairs:`,
        `  Genomic neighborhood (±10 flanking genes):`,
        `    from=compara_neighbors_10  to=compara_idx_multi`,
        `    seed_q=gene_tree:<id>  or  seed_q=id:<gene_id>`,
        `  Both fields are pint (integer) — compara_idx_multi holds each gene's compara index,`,
        `  and compara_neighbors_10 holds the compara_idx_multi values of its ±10 flanking genes.`,
        ``,
        `Chained-graph pattern for PAV/CNV across a species panel:`,
        `  1. Seed q: id:<gene_id> traversing homology__all_orthologs → ortholog gene IDs`,
        `  2. Re-seed with those IDs traversing compara_neighbors_10 → compara_idx_multi,`,
        `     fq:["taxonomy__ancestors:<plain NCBI id>"], facet on system_name`,
        `  Per-genome facet counts give copy number; missing genomes (cross-checked against`,
        `  mongo maps where in_compara=true) are PAV.`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Field containing outgoing edge values (adjacency list). E.g. 'compara_neighbors_10'.",
          },
          to: {
            type: "string",
            description: "Field containing the node ID of each document. E.g. 'compara_idx_multi'.",
          },
          seed_q: {
            type: "string",
            description: "Seed query identifying the root node(s). E.g. 'gene_tree:EPlGT00140000004862' or 'id:AT1G01010'.",
          },
          traversalFilter: {
            type: "string",
            description: "Optional Solr filter query applied to candidate nodes during traversal (prunes the graph).",
          },
          returnRoot: {
            type: "boolean",
            description: "Include seed documents in the result set. Default: true.",
          },
          fq: { type: "array", items: { type: "string" }, description: "Additional filter queries on the result set." },
          fl: { type: "string", description: "Comma-separated field list to return." },
          rows: { type: "integer", minimum: 0, maximum: 1000, description: "Max documents to return. Default: 100." },
          start: { type: "integer", minimum: 0 },
          sort: { type: "string" },
        },
        required: ["from", "to", "seed_q"],
      },
    },
    handler: tool_solr_graph,
  },
  kb_relations: {
    definition: {
      name: "kb_relations",
      description: "Return Solr↔MongoDB relationship metadata describing how Solr fields map to MongoDB collections (field crosswalks).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => KB_RELATIONS,
  },
  genes_in_region: {
    definition: {
      name: "genes_in_region",
      description: [
        `Find all genes in the Solr genes core that overlap a genomic interval.`,
        `Returns genes where gene.start ≤ end AND gene.end ≥ start on the given region (chromosome).`,
        `Useful as the first step in QTL candidate gene analysis.`,
        ``,
        `Species filter: pass the plain NCBI taxon ID via 'taxon_id' — it is applied internally`,
        `as taxonomy__ancestors:<id>, matching all subspecies and assemblies under that taxon.`,
        `Do NOT pass the NCBI×1000+suffix encoding (e.g. 4558001); use the plain ID (e.g. 4558).`,
        ``,
        `Key fields to request via 'fl':`,
        `  id, name, biotype, start, end, strand, system_name`,
        `  gene_tree, compara_idx_multi          — for graph traversal to find conserved neighbors`,
        `  TO__ancestors, GO__ancestors          — for ontology-based scoring`,
        `  expressed_in_gxa_attr_ss              — joinable to mongo experiments / assays`,
        `  closest_rep_name, model_rep_name      — display name fallbacks`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          region:   { type: "string",  description: "Chromosome / scaffold name (e.g. '6', 'Chr01')." },
          start:    { type: "integer", description: "Interval start coordinate (bp, inclusive)." },
          end:      { type: "integer", description: "Interval end coordinate (bp, inclusive)." },
          taxon_id: { type: "integer", description: "Plain NCBI taxon ID (e.g. 4558 for Sorghum bicolor). Applied as taxonomy__ancestors filter; matches all subspecies/assemblies." },
          map:      { type: "string",  description: "Assembly accession to filter by (e.g. 'GCA_000003195.3')." },
          fl:       { type: "string",  description: "Comma-separated Solr field list to return." },
          rows:     { type: "integer", minimum: 0, maximum: 1000, description: "Max genes to return (default 200)." },
          sort:     { type: "string",  description: "Sort clause, e.g. 'start asc'." },
        },
        required: ["region", "start", "end"],
      },
    },
    handler: tool_genes_in_region,
  },
  expression_for_genes: {
    definition: {
      name: "expression_for_genes",
      description: [
        `Retrieve baseline and differential expression for a list of gene IDs in a single`,
        `Solr round-trip. Reads the encoded expression fields directly from the genes core`,
        `(*__expr, *_l2fc_attr_f, *_pval_attr_f) and joins with cached experiment + assay`,
        `metadata; no MongoDB query is needed per call.`,
        ``,
        `Per-gene response shape:`,
        `  experiments_with_data — string[] of GXA experiment accessions covering this gene`,
        `  baseline[]            — { experiment, experiment_name, group, value, tissue, factors }`,
        `                          value is TPM/FPKM from Baseline experiments`,
        `  differential[]        — { experiment, experiment_name,`,
        `                            control_group, treatment_group,`,
        `                            control_tissue, treatment_tissue,`,
        `                            control_factors, treatment_factors,`,
        `                            contrast, shared_factors,`,
        `                            l2fc, p_value }`,
        `                          contrast[]      — factor types whose value differs between`,
        `                                             control and treatment ({type, control, treatment})`,
        `                          shared_factors[] — factor types with identical values in both assays`,
        ``,
        `Filters:`,
        `  experiment_type = "Baseline" | "Differential" — narrow the field set returned.`,
        `  taxon_id (plain NCBI int) — restrict to experiments performed in that species.`,
        `  po_terms — array of PO int IDs. A baseline row matches when its assay carries any`,
        `             of the PO ints. A differential row matches when EITHER the control or`,
        `             treatment assay does.`,
        ``,
        `PO ancestor fallback: PO ancestors are unioned into the filter up-front. If no row`,
        `matched a literally-requested PO id but rows did match an ancestor, the response`,
        `flags po_filter.expanded=true. Shape:`,
        `  po_filter: { requested:[...], expanded:bool, ancestors_used:[...] }`,
        ``,
        `Common PO int IDs: 9001=grain/fruit, 9089=endosperm, 25034=leaf, 20127=stem,`,
        `                   7010=germination stage, 7016=flowering stage.`,
        ``,
        `Cross-species comparison: include ortholog gene IDs from any species in gene_ids;`,
        `they are all returned in the same response, suitable for conserved-candidate`,
        `prioritization across orthologs.`,
        ``,
        `Discovery hint: each gene also returns experiments_with_data (sourced from the Solr`,
        `field expressed_in_gxa_attr_ss). Useful for "which studies cover this gene at all?"`,
        `without inspecting every value.`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: {
            type: "array",
            items: { type: "string" },
            description: "Gene stable IDs to look up (max 500). Include ortholog IDs from other species for cross-species comparison.",
          },
          experiment_type: {
            type: "string",
            enum: ["Baseline", "Differential"],
            description: "Limit to one experiment type. Omit for both.",
          },
          taxon_id: {
            type: "integer",
            description: "Filter experiments to a specific species (NCBI taxon ID, e.g. 4558 for sorghum).",
          },
          po_terms: {
            type: "array",
            items: { type: "integer" },
            description: "PO term int IDs to restrict to trait-relevant tissues/conditions. E.g. [9001, 9089] for grain/endosperm.",
          },
        },
        required: ["gene_ids"],
      },
    },
    handler: tool_expression_for_genes,
  },

  vep_for_gene: {
    definition: {
      name: "vep_for_gene",
      description: [
        `Retrieve predicted loss-of-function (LOF) germplasm alleles for one or more genes.`,
        ``,
        `Uses Ensembl VEP (Variant Effect Prediction) annotations indexed in Solr dynamic`,
        `fields (VEP__*). For each gene, returns germplasm accessions that carry predicted`,
        `high-impact variants grouped by:`,
        `  - VEP consequence (e.g. 'stop gained', 'splice acceptor variant')`,
        `  - Zygosity (homozygous / heterozygous)`,
        `  - Study/population (e.g. 'Sorghum Genomics Toolbox', 'Boatwright SAP', 'Purdue EMS')`,
        `  - Study type (EMS = ethyl-methanesulfonate mutagenesis; NAT = natural diversity)`,
        ``,
        `Also returns the merged EMS and NAT totals from VEP__merged__EMS/NAT__attr_ss.`,
        ``,
        `Germplasm metadata (pub_id, stock_center, subpopulation, genebank URL) is enriched`,
        `from the MongoDB 'germplasm' collection when available.`,
        ``,
        `Use cases:`,
        `  - "Which accessions have a predicted stop-gained in SORBI_3006G095600?"`,
        `  - "Are there EMS knockout lines for this gene?"`,
        `  - "Find natural accessions with a LOF allele in this gene for association studies"`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: {
            type: "array",
            items: { type: "string" },
            description: "Gene stable IDs to query (max 50). E.g. ['SORBI_3006G095600'].",
          },
          include_germplasm_details: {
            type: "boolean",
            description: "Whether to enrich accession IDs with germplasm metadata (pub_id, stock_center, subpopulation, genebank URL) from MongoDB. Default true. Set false for a count-only summary.",
          },
        },
        required: ["gene_ids"],
      },
    },
    handler: tool_vep_for_gene,
  },

  pubmed_for_genes: {
    definition: {
      name: "pubmed_for_genes",
      description: [
        "Return PubMed and DOI cross-references for a list of genes from the Solr genes index.",
        "Per gene the response carries `pmids` (numeric PubMed IDs as strings) and `dois`",
        "(DOI strings, stripped of the 'DOI:' prefix); only genes flagged with",
        "`capabilities:pubs` carry references.",
        "",
        "This tool does NOT fetch paper metadata (title, authors, journal, abstract) — that",
        "is the job of a separate, PubMed-focused MCP server. Pipe the `pmids`/`dois`",
        "arrays from this tool into that server when bibliographic detail is needed.",
        "",
        "Use to find which candidate genes have literature, and to assemble PMID/DOI lists",
        "to expand to orthologs in well-studied model species.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: {
            type: "array",
            items: { type: "string" },
            description: "Gene stable IDs to look up references for (max 500). Include orthologs from other species to widen literature coverage.",
          },
        },
        required: ["gene_ids"],
      },
    },
    handler: tool_pubmed_for_genes,
  },
};

const TOOLS = Object.values(TOOL_REGISTRY).map((t) => t.definition);

// --- Prompts ---
// Exposes the research workflows from AGENT_PROMPT_v2.md as MCP Prompts
// (`prompts/list` / `prompts/get`). This lets agents load workflow instructions
// on demand instead of carrying all of them in the base system prompt —
// significantly reducing per-turn token usage.
//
// Each prompt has:
//   - name, title, description (returned by prompts/list)
//   - arguments: optional list of {name, description, required} (MCP spec)
//   - messages(args) → array of { role, content: { type:"text", text } }
//     built from static text with optional {{placeholder}} substitution.
//
// Convention: {{var}} placeholders in the template are replaced with the
// values from the `arguments` object passed by the client; missing optional
// placeholders are replaced with an empty string. Required arguments are
// validated before templating.

function renderTemplate(template, args = {}) {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    const v = args[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

const PROMPT_REGISTRY = {
  base: {
    definition: {
      name: "base",
      title: "Gramene agent — base context",
      description:
        "Role, query routing, critical conventions, and data overview. Load once at session start. " +
        "All workflow prompts assume this context is in scope.",
      arguments: [],
    },
    template: `# Gramene MCP Agent — Base Context

## Role

You are a plant genomics research assistant connected to the Gramene database
via an MCP server. Gramene integrates gene annotation, comparative genomics,
gene expression, ontology, and QTL data across dozens of plant species with an
emphasis on crops.

When a question requires multiple steps, chain tool calls together and
synthesize the results into a clear, biologically meaningful answer. Always
interpret raw data (gene IDs, ontology integers, expression values) for the
user rather than dumping raw JSON. Load additional workflow prompts
(\`prompts/get\`) when a user's question matches one of them — this keeps base
context small.

## Run independent calls in parallel

Each tool call costs one model turn. Running independent calls sequentially
multiplies that latency for no reason. Whenever the next set of calls do not
depend on each other's outputs, **emit them in a single turn** — most clients
will dispatch them concurrently.

A call A depends on call B only when B's output supplies an argument A needs.
If A and B share a starting input, or operate on the same gene list, or query
different backends entirely, they are independent.

Concrete patterns:

- Resolving multiple unrelated names (e.g. a pathway and a species) → run both
  \`solr_suggest\` calls in one turn.
- For a fixed gene list: \`expression_for_genes\`, \`vep_for_gene\`, and
  \`pubmed_for_genes\` are independent — fire all three together.
- For a known QTL interval: \`genes_in_region\` and any background-genome facet
  query for the same species can run in parallel.
- Workflow prompts mark concurrent steps with **[parallel with Step N]** —
  treat those step groups as one batch.

Sequential is only correct when one call literally needs another's result
(e.g. \`solr_suggest\` → use returned \`fq_value\` in \`solr_search\`).

## Query Routing

Always start with \`solr_suggest\` for any free-text concept (gene name,
family, pathway, species, ontology term, trait). Reserve \`mongo_find\` for
fetching detail records once you already have a specific ID.

| User question shape | Start with | Load workflow |
|---------------------|------------|---------------|
| Single gene by ID ("tell me about SORBI_…") | \`solr_search\` (q="id:…") | — (build a gene card) |
| Gene name / function lookup | \`solr_suggest\` (term=) | \`gene_lookup\` |
| "Genes in pathway X for species Y" | \`solr_suggest\` (q= for pathway and species) | \`pathway_genes\` |
| Trait → QTL discovery ("QTLs for plant height") | \`solr_suggest\` (q='name:"…"' fq='category:Trait Ontology') | \`qtl_discovery\` |
| QTL interval / trait candidate analysis | \`genes_in_region\` | \`qtl_candidate_ranking\` |
| "What's known about gene X?" | \`solr_search\` for metadata | \`literature_search\` |
| Cross-species comparison for a gene | \`solr_search\` for \`gene_tree\` | \`cross_species_comparison\`, \`orthologs_paralogs\` |
| Gene family across species | \`solr_suggest\` (pick largest num_genes) | \`gene_family\` |
| Family expansion / contraction across clades | \`solr_search\` (gene_tree facet on taxonomy__ancestors) | \`gene_family_expansion\` |
| Germplasm / LOF alleles | \`vep_for_gene\` | \`germplasm_lof\` |
| Presence/Absence or CNV | \`solr_search\` with facets / chained \`solr_graph\` | \`pav_cnv\` |
| Ambiguous or exploratory | \`kb_relations\` first | — |

Enrichment / overrepresentation analysis is **not** an MCP tool. Use
\`solr_search\` with facet.field on the relevant ontology field for both
foreground and background, then run the client-side enrichment skill on the
two frequency arrays.

## Critical Conventions

**Taxon ID — use the plain NCBI ID.**
- Filter with \`taxonomy__ancestors:<plain NCBI id>\` (e.g. \`4558\` sorghum,
  \`3702\` Arabidopsis, \`39947\` rice). Matches all subspecies/assemblies.
- The \`genes_in_region\` \`taxon_id\` parameter takes the plain NCBI ID and
  applies it as \`taxonomy__ancestors\` internally.
- The Solr \`taxon_id\` *field* on individual gene documents uses
  NCBI×1000+suffix (e.g. \`4558001\` for sorghum BTx623). Avoid filtering on
  it directly unless you specifically need a single assembly.

**Gene ID format — never abbreviate.** Always write the full stable identifier
(e.g. \`SORBI_3006G095600\`, never \`G095600\`). This applies everywhere.

**Display name rule.** Show genes as
\`GENE_ID / CLOSEST_NAME (description)\` — e.g.
\`SORBI_3006G147000 / RPL14B (60S ribosomal protein L14-2)\`. Fallback chain
when \`name\` equals the stable ID: \`closest_rep_name\` → \`model_rep_name\`
→ \`description\` → stable ID alone. Never show a bare gene ID without at
least one of these.

**Homology field choice.** Default to \`homology__all_orthologs\` for
cross-species inference. Use \`homology__ortholog_one2one\` only for tight
pairs (e.g. sorghum ↔ rice); maize is a paleopolyploid (1:many is common
against sorghum/rice/wheat) and monocot ↔ Arabidopsis comparisons are too
distant for stable 1:1 mappings.

**\`mongo_find\` parameter name.** The filter parameter is \`filter\`, not
\`query\`. Passing \`query: { ... }\` is silently ignored and returns
unfiltered results.

**Chromosome names.** Must match the stored \`region\` field exactly. Sorghum
uses \`"1"\`–\`"10"\` (bare digits). Other species may use \`"Chr01"\` —
check a known gene first if unsure.

## Data Overview

**Solr** — \`genes\` core (one doc per gene with coordinates, ontology ancestor
integer arrays, gene family IDs, compara graph fields, xrefs) and
\`suggestions\` core (typeahead with \`fq_field\`/\`fq_value\` that plug
directly into genes-core filter queries).

**MongoDB** collections: \`genes\`, \`genetree\`, \`taxonomy\`, \`GO\`, \`PO\`,
\`TO\`, \`domains\`, \`pathways\`, \`assays\`, \`experiments\`, \`expression\`,
\`qtls\`, \`maps\`, \`germplasm\`.

## Species Reference (expression experiments)

| Taxon ID | Species |
|----------|---------|
| 3702 | *Arabidopsis thaliana* |
| 3847 | *Glycine max* (soybean) |
| 4530 | *Oryza sativa* (rice) |
| 4558 | *Sorghum bicolor* |
| 4565 | *Triticum aestivum* (wheat) |
| 4577 | *Zea mays* (maize) |
| 29760 | *Vitis vinifera* (grapevine) |

## Fallback guidance

When a tool returns empty or unexpected results, do not silently give up —
try the fallback listed in the per-workflow prompt or, if you don't have one
loaded, call \`kb_relations\` to see available fields and try a broader
filter. Never fabricate data.

## Limitations

- Plant species only — animal/microbial genomes are out of scope.
- Expression data covers ~7 species (see table). Empty = coverage gap, not a bug.
- VEP / germplasm coverage is richest for sorghum.
- Variant-level queries (sub-genic context, promoter/UTR variants, specific
  alleles) are not supported by the API yet; \`vep_for_gene\` returns
  predicted-LOF accession lists only.
- Enrichment / overrepresentation analysis is delegated to a client-side
  skill that runs on facet-count arrays from \`solr_search\`.
- All access is read-only. Do not invent gene names, pathway annotations,
  expression values, publications, or germplasm accessions.`,
  },

  gene_lookup: {
    definition: {
      name: "gene_lookup",
      title: "Gene name or function lookup",
      description:
        "Translate a gene/protein name or function description into a gene list, " +
        "optionally filtered by species. Use when the user asks 'what is X?' or " +
        "'find me genes related to Y'.",
      arguments: [
        { name: "query", description: "The user's free-text term (gene name, protein family, function).", required: true },
        { name: "species", description: "Optional species name or common name to restrict the result set.", required: false },
      ],
    },
    template: `# Workflow: Gene name or function lookup

**User query:** {{query}}
**Species filter:** {{species}}

## Steps

1. \`solr_suggest(term: "{{query}}")\` — ranked fuzzy search across name, IDs,
   synonyms, and text. Pick the result whose \`fq_field\`/\`fq_value\` matches
   what the user wants (gene tree, GO term, InterPro domain, etc.).

2. If a species filter was given, resolve it:
   \`solr_suggest(q: 'name:"{{species}}"')\` → \`fq_field=taxonomy__ancestors\`,
   \`fq_value=<NCBI ID>\`.

3. Fetch genes:
   \`\`\`
   solr_search_bool(
     filter: { op: "AND", args: [
       { term: { field: "<suggest fq_field>", value: <suggest fq_value> } },
       { term: { field: "taxonomy__ancestors", value: <species fq_value> } }
     ]},
     fl: "id,name,description,closest_rep_name,closest_rep_description,model_rep_name,biotype,region,start,end"
   )
   \`\`\`

4. Render using the **display-name rule** (see base context).

## Fallbacks

- \`solr_suggest\` returns nothing → try broader terms; switch between
  \`term=\` and \`q=\` modes; check spelling.
- Top result is InterPro/GO instead of the expected gene family → use
  \`q='name:"<exact term>"'\` instead of \`term=\`.`,
  },

  pathway_genes: {
    definition: {
      name: "pathway_genes",
      title: "Genes in pathway X for species Y (+ optional tissue)",
      description:
        "Retrieve all genes in a named Plant Reactome pathway for a given species, " +
        "optionally ranked by expression in a specific tissue.",
      arguments: [
        { name: "pathway", description: "Pathway name, e.g. 'Jasmonic acid biosynthesis'.", required: true },
        { name: "species", description: "Species name, e.g. 'Sorghum bicolor'.", required: true },
        { name: "po_term", description: "Optional PO tissue integer ID (e.g. 9089 for endosperm) to rank by expression.", required: false },
      ],
    },
    template: `# Workflow: Genes in a pathway for a species

**Pathway:** {{pathway}}
**Species:** {{species}}
**Tissue PO term:** {{po_term}}

Plant Reactome pathway annotations are more precise than GO or
description-based searches: they capture the specific enzymatic steps curated
for that pathway. Use exact-name queries (\`q=\`) — \`term=\` is dominated by
InterPro/GO and may not surface Reactome entries.

## Steps

1. Resolve the pathway:
   \`\`\`
   solr_suggest(q: 'name:"{{pathway}}"')
     → fq_field=pathways__ancestors, fq_value=<N>
   \`\`\`

2. Resolve the species:
   \`\`\`
   solr_suggest(q: 'name:"{{species}}"')
     → fq_field=taxonomy__ancestors, fq_value=<M>
   \`\`\`

3. Fetch genes:
   \`\`\`
   solr_search(
     fq: ["pathways__ancestors:<N>", "taxonomy__ancestors:<M>"],
     fl: "id,name,description,biotype,closest_rep_name,model_rep_name",
     rows: 200
   )
   \`\`\`

4. (Optional) Tissue-expression filter:
   \`\`\`
   expression_for_genes(
     gene_ids: [...],
     experiment_type: "Baseline",
     po_terms: [{{po_term}}]
   )
     → rank by baseline TPM in tissue of interest
   \`\`\`

## Common PO tissue term IDs

| PO int ID | Tissue |
|-----------|--------|
| 9001  | fruit (grain) |
| 9089  | endosperm |
| 25034 | leaf |
| 20127 | primary root |
| 9005  | root |
| 7016  | whole plant flowering stage |`,
  },

  qtl_candidate_ranking: {
    definition: {
      name: "qtl_candidate_ranking",
      title: "QTL candidate gene ranking",
      description:
        "Full workflow for ranking candidate genes in a QTL interval by ontology, " +
        "expression, ortholog conservation, and literature. Either supply the TO " +
        "term (and the workflow pulls the QTL coordinates) or supply the region/start/end directly.",
      arguments: [
        { name: "trait_to_term", description: "Trait Ontology term ID (e.g. 'TO:0000396') for looking up QTL coordinates.", required: false },
        { name: "region", description: "Chromosome (e.g. '6' for sorghum, 'Chr01' for other species).", required: false },
        { name: "start", description: "Interval start (bp, inclusive).", required: false },
        { name: "end", description: "Interval end (bp, inclusive).", required: false },
        { name: "taxon_id", description: "Plain NCBI taxon ID for the species (e.g. 4558 for sorghum). Applied as taxonomy__ancestors filter.", required: true },
      ],
    },
    template: `# Workflow: QTL candidate gene ranking

**Trait TO term:** {{trait_to_term}}
**Region:** {{region}}
**Start:** {{start}}
**End:** {{end}}
**NCBI taxon ID:** {{taxon_id}}

> **Concurrency note.** Steps marked **[parallel with Step N]** have no data
> dependency on each other and SHOULD be emitted as multiple tool calls in a
> single turn so the client dispatches them concurrently. Each model turn is
> the dominant cost — collapsing turns is the biggest speedup available.

## Step 0 — Resolve the trait if only a name is known
If the user gave a trait name rather than a TO ID:
\`\`\`
solr_suggest(q: 'name:"<trait>"', fq: ['category:Trait Ontology'])
  → returns fq_value (TO integer ID) and the canonical TO:NNNNNNN string
\`\`\`

## Step 1 — Find the QTL interval
If a trait TO term was supplied (or just resolved):
\`\`\`
mongo_find(collection: "qtls", filter: { "terms": "{{trait_to_term}}" })
  → get location.region, location.start, location.end
\`\`\`
Otherwise, use the supplied region / start / end directly.

## Step 2 — Get all genes in the interval
\`\`\`
genes_in_region(
  region: "{{region}}",
  start: {{start}},
  end: {{end}},
  taxon_id: {{taxon_id}},
  fl: "id,name,biotype,start,end,gene_tree,TO__ancestors,GO__ancestors,compara_idx_multi,closest_rep_id,closest_rep_name,closest_rep_description,model_rep_id,model_rep_name,model_rep_description"
)
\`\`\`

## Step 2b — Sanity-check the gene count
A typical QTL interval yields **5–200 genes**.
- **0 genes** → chromosome-name or coordinate-format error (see base
  conventions). Verify with a known gene on that chromosome.
- **>500 genes** → interval probably too broad. Confirm with the user before
  downstream expensive analyses.

---

The next four steps (3, 4, 5, 6) all consume the gene list from Step 2 but
do NOT depend on each other's outputs. Emit them as one batch of concurrent
tool calls in a single turn.

## Step 3 — Score by ontology  [parallel with Steps 4, 5, 6]
\`\`\`
mongo_lookup_by_ids(
  collection: "TO",
  ids: <TO__ancestors integers from step-2 genes>
)
  → identify genes annotated to the trait or its ancestors
\`\`\`

## Step 4 — Find conserved orthologs  [parallel with Steps 3, 5, 6]
\`\`\`
solr_graph(
  from: "compara_neighbors_10",
  to:   "compara_idx_multi",
  seed_q: "gene_tree:<id>",
  fl: "id,system_name,gene_tree,name,closest_rep_name"
)
  → collect ortholog gene IDs across species
\`\`\`
(Ortholog IDs from Step 4 widen the gene list used by Steps 5 and 6 on a
*subsequent* turn — but the initial regional-gene call to those tools can run
in this batch.)

## Step 5 — Score by expression  [parallel with Steps 3, 4, 6]
Both calls below operate on the same gene list and are independent — emit
them in the same turn:
\`\`\`
expression_for_genes(
  gene_ids: <regional genes>,
  experiment_type: "Baseline",
  taxon_id: {{taxon_id}},
  po_terms: [<trait-relevant tissue PO IDs>]
)
expression_for_genes(
  gene_ids: <regional genes>,
  experiment_type: "Differential"
)
  → flag significant DE (p < 0.05) in relevant conditions
\`\`\`
After Step 4 returns, optionally re-run with \`gene_ids: <regional + orthologs>\`
in a follow-up turn to extend the comparison across species.

## Step 6 — Literature evidence  [parallel with Steps 3, 4, 5]
\`\`\`
pubmed_for_genes(gene_ids: <regional genes>)
  → per-gene pmids[] and dois[]; non-empty = literature exists
\`\`\`
After Step 4 returns, repeat with the ortholog IDs in a follow-up turn for
broader coverage. Hand resolved PMIDs to a PubMed-focused MCP for titles
and abstracts.

## Step 6b — Loss-of-function germplasm bonus  [parallel with Steps 3, 4, 5]
\`\`\`
vep_for_gene(gene_ids: <regional genes>)
  → predicted LOF accessions per gene (sorghum-richest)
\`\`\`

---

## Step 7 — Synthesize ranking

Score each gene on:
- TO/GO annotation relevance (0–3 pts)
- Expressed in trait-relevant tissue (0–2 pts)
- Significant DE under trait-relevant condition (0–2 pts)
- Conserved expression across orthologous species (0–2 pts)
- Published functional characterization (0–3 pts: 3=direct study, 2=ortholog studied, 1=mentioned)
- LOF germplasm available (bonus flag from Step 6b)

Output: ranked table with explicit subtotals so the user can audit the
ranking. Report filter counts at every step (e.g. "120 genes in the interval
→ 34 with TO annotation to yield trait → 12 also DE in grain").`,
  },

  literature_search: {
    definition: {
      name: "literature_search",
      title: "Literature cross-references for a gene (with ortholog fallback)",
      description:
        "Collect PubMed and DOI cross-references for a gene; if the gene has none, expand " +
        "to rice and Arabidopsis orthologs. Hand the resulting PMID/DOI lists to a " +
        "PubMed-focused MCP for bibliographic detail.",
      arguments: [
        { name: "gene_id", description: "Gene stable ID (e.g. 'SORBI_3006G095600').", required: true },
      ],
    },
    template: `# Workflow: Literature cross-references for a candidate gene

**Gene:** {{gene_id}}

Crop genes often have limited direct publications. Always include orthologs
from model species (rice, Arabidopsis) before concluding "no literature."

## Step 1 — Resolve the gene and its orthologs
\`\`\`
solr_search(
  q: "id:{{gene_id}}",
  fl: "id,name,gene_tree,homology__all_orthologs,closest_rep_id,model_rep_id"
)
\`\`\`
Extract ortholog IDs, especially from rice (Os…) and Arabidopsis (AT…).

## Step 2 — Fetch references for the gene + orthologs
\`\`\`
pubmed_for_genes(gene_ids: ["{{gene_id}}", <ortholog_ids...>])
\`\`\`

Response shape (per gene): \`name\`, \`description\`, \`pmids: string[]\`,
\`dois: string[]\`, \`count\`. Top level also reports
\`gene_count\`, \`genes_with_refs\`, \`total_unique_pmids\`,
\`total_unique_dois\`.

## Step 3 — Resolve to bibliographic detail
This MCP returns IDs only. For titles, authors, journals, and abstracts,
pass the union of \`pmids\` and \`dois\` into a PubMed-focused MCP server.

## Fallbacks
- Absence of references for \`{{gene_id}}\` does **not** mean the gene is
  unstudied — only that Gramene's index has no PubMed/DOI cross-reference for
  it. Always consult rice and Arabidopsis orthologs before concluding.
- Only genes with \`capabilities:pubs\` have literature cross-references;
  the tool filters for this automatically.`,
  },

  cross_species_comparison: {
    definition: {
      name: "cross_species_comparison",
      title: "Cross-species comparison for a gene of interest",
      description:
        "For a given gene, collect its full ortholog set (via gene tree / compara graph) " +
        "and compare tissue expression profiles across species.",
      arguments: [
        { name: "gene_id", description: "Gene stable ID for the query gene.", required: true },
      ],
    },
    template: `# Workflow: Cross-species comparison

**Query gene:** {{gene_id}}

> **Concurrency note.** Steps marked **[parallel with Step N]** have no data
> dependency on each other and SHOULD be emitted as multiple tool calls in a
> single turn. Each model turn is the dominant cost — collapse them where you
> can.

## Choosing the homology field

\`homology__ortholog_one2one\` is reliable only between species that lack a
recent whole-genome duplication relative to each other. Several common cases
break that assumption:

- **Maize is a paleopolyploid.** Sorghum/rice/wheat ↔ maize comparisons are
  frequently 1:many, not 1:1.
- **Monocot ↔ Arabidopsis** is too distant for stable 1:1 mappings.

For comparisons that involve maize, or that span monocots and dicots, prefer
\`homology__all_orthologs\` (or \`gene_tree:<id>\`) so 1:many and many:many
orthologs are not silently dropped. Reserve \`homology__ortholog_one2one\` for
tight pairs (e.g. sorghum ↔ rice).

## Step 1 — Get the gene tree and full ortholog set
\`\`\`
solr_search(
  q: "id:{{gene_id}}",
  fl: "id,gene_tree,homology__all_orthologs,homology__ortholog_one2one,compara_idx_multi"
)
\`\`\`

---

After Step 1, the gene tree ID is known. Steps 2 and 3 both consume it but
do not depend on each other — emit them as one batch in a single turn.

## Step 2 — Retrieve all family members  [parallel with Step 3]
\`\`\`
solr_search(
  q: "gene_tree:<tree_id>",
  fl: "id,name,system_name,taxon_id,closest_rep_name",
  rows: 500
)
\`\`\`
Or, for ±10-gene neighborhood context per ortholog (single hop):
\`\`\`
solr_graph(
  from: "compara_neighbors_10",
  to:   "compara_idx_multi",
  seed_q: "gene_tree:<tree_id>",
  fl: "id,name,system_name,closest_rep_name"
)
\`\`\`

## Step 3 — Per-clade copy counts  [parallel with Step 2]
\`\`\`
solr_search(
  q: "gene_tree:<tree_id>",
  rows: 0,
  facet: { field: "taxonomy__ancestors", mincount: 1, limit: -1 }
)
  → surfaces lineage-specific expansion / contraction without a separate turn
\`\`\`

## Step 4 — Compare expression across species
After Step 2 returns the ortholog IDs:
\`\`\`
expression_for_genes(
  gene_ids: <ortholog IDs from Step 2>,
  experiment_type: "Baseline"
)
\`\`\`

(If you also want literature coverage, run \`pubmed_for_genes\` with the same
ortholog list in the same turn as Step 4 — they are independent.)

## Output
Group the rendered table by species. For each ortholog, show the
relationship type (\`ortholog_one2one\`, \`ortholog_one2many\`, etc.) next to
the gene ID. End with a 2–3 sentence biological interpretation.`,
  },

  orthologs_paralogs: {
    definition: {
      name: "orthologs_paralogs",
      title: "Querying orthologs, paralogs, and homologs (Ensembl Compara)",
      description:
        "Reference workflow for picking the right homology query field in Solr / MongoDB " +
        "for orthologs, paralogs, gene splits, and full gene families.",
      arguments: [
        { name: "gene_id", description: "Gene stable ID to query.", required: false },
      ],
    },
    template: `# Workflow: Orthologs, paralogs, and homologs

**Query gene (if any):** {{gene_id}}

## Terminology (Ensembl Compara)
- **Homologs** = all genes in the same gene family tree (orthologs + paralogs + gene splits).
  Query with \`gene_tree:<id>\` → complete gene family.
- **Orthologs** = homologs separated by a *speciation* event (different species).
  Use \`homology__all_orthologs\` (any ortholog) or typed fields for confidence levels.
- **Paralogs** = homologs separated by a *duplication* event.
  Use \`homology__within_species_paralog\` for intra-genome paralogs.

## Solr fields for homology queries

| Field | Relationship | Confidence |
|-------|-------------|------------|
| \`gene_tree:<id>\` | All homologs (full gene family) | — |
| \`homology__all_orthologs\` | All orthologs across all species | — |
| \`homology__ortholog_one2one\` | Strict 1:1 orthologs | Highest |
| \`homology__ortholog_one2many\` | 1:many — duplicated in target | Medium |
| \`homology__ortholog_many2many\` | Many:many — duplicated in both | Lower |
| \`homology__within_species_paralog\` | Intra-species paralogs | — |
| \`homology__gene_split\` | Assembly-fragmented gene pairs | — |

## Example queries

\`\`\`
# All sorghum genes that are 1:1 orthologs of a rice gene
solr_search(q: "homology__ortholog_one2one:Os04g0447100",
            fq: ["taxonomy__ancestors:4558"])

# Get all orthologs of {{gene_id}} (via gene tree)
solr_search(q: "id:{{gene_id}}", fl: "id,gene_tree,homology__all_orthologs")
  → use gene_tree ID to retrieve full family, or all_orthologs list directly

# All members of a gene family across all species
solr_search(q: "gene_tree:<tree_id>", fl: "id,name,system_name", rows: 200)

# Species-specific orthologs
solr_search(q: "gene_tree:<tree_id>",
            fq: ["taxonomy__ancestors:39947"],   # 39947 = Oryza sativa
            fl: "id,name,system_name,homology__ortholog_one2one")

# Paralogs within sorghum
solr_search(q: "homology__within_species_paralog:{{gene_id}}",
            fq: ["taxonomy__ancestors:4558"])
\`\`\`

## Recommendation
- Default to \`homology__all_orthologs\` for cross-species inference. It
  captures 1:1, 1:many, and many:many in one field — important whenever maize
  (a paleopolyploid) is involved or whenever the comparison crosses the
  monocot/dicot boundary, since 1:1 mappings are rare in those cases.
- Use \`homology__ortholog_one2one\` only for tight pairs (e.g. sorghum ↔
  rice) where 1:1 is the dominant relationship and you want maximal confidence.
- Use \`gene_tree:<id>\` when you want the full family including paralogs.

## MongoDB homology structure (from \`mongo_find\` on \`genes\`)
\`\`\`json
{
  "homology": {
    "gene_tree": {
      "id": "SB10GT_332720",
      "root_taxon_id": 33090,
      "representative": {
        "closest": { "id": "Os04g0447100", "percent_identity": 78.4, "taxon_id": 39947 },
        "model":   { "id": "AT1G17420",   "percent_identity": 65.1, "taxon_id": 3702 }
      }
    },
    "homologous_genes": {
      "ortholog_one2one":  [ { "id": "...", "system_name": "...", ... } ],
      "ortholog_one2many": [ ... ],
      "within_species_paralog": [ ... ]
    }
  }
}
\`\`\``,
  },

  gene_family: {
    definition: {
      name: "gene_family",
      title: "Explore a gene family across species",
      description:
        "Resolve a gene family name to a gene tree and list all its members across species.",
      arguments: [
        { name: "family", description: "Gene family or protein family name (e.g. 'lipoxygenase').", required: true },
      ],
    },
    template: `# Workflow: Explore a gene family across species

**Family:** {{family}}

## Steps

1. Resolve the family to a gene tree:
   \`\`\`
   solr_suggest(term: "{{family}}")
     → pick the result with fq_field=gene_tree and its fq_value
   \`\`\`
   If a \`gene_tree\` entry isn't in the top results (InterPro/GO may
   dominate), switch to \`q\`-mode or pick the highest-\`num_genes\` candidate.

2. Fetch all members:
   \`\`\`
   solr_search_bool(
     filter: { term: { field: "gene_tree", value: <id> } },
     fl: "id,name,system_name,start,end,closest_rep_name,model_rep_name",
     rows: 1000
   )
   \`\`\`

3. (Optional) Group by species and report per-genome copy counts to surface
   duplications / PAV across the family.`,
  },

  germplasm_lof: {
    definition: {
      name: "germplasm_lof",
      title: "Germplasm with predicted loss-of-function alleles",
      description:
        "Find EMS and NAT germplasm accessions that carry predicted loss-of-function " +
        "alleles in one or more genes (via Ensembl VEP annotations).",
      arguments: [
        { name: "gene_ids", description: "Comma-separated list of gene stable IDs (max 50).", required: true },
      ],
    },
    template: `# Workflow: Germplasm with predicted LOF alleles

**Gene IDs:** {{gene_ids}}

## Step 1 — Direct VEP query
\`\`\`
vep_for_gene(gene_ids: [{{gene_ids}}])
\`\`\`

## (Optional) Step 2 — Combine with pathway / expression context
\`\`\`
# Narrow to candidate genes by pathway first
solr_search(fq: ["pathways__ancestors:<N>", "taxonomy__ancestors:4558"],
            fl: "id,name")
# Feed the result list into vep_for_gene, then prioritize by tissue expression
expression_for_genes(gene_ids: [...], po_terms: [<tissue PO IDs>])
\`\`\`

## Response structure
- \`summary.total_lof_accessions\` — unique accessions with any LOF allele
- \`summary.ems_accessions\` — EMS mutagenesis knockout lines
- \`summary.nat_accessions\` — natural diversity accessions (GWAS-relevant)
- \`groups[]\` — per-consequence / per-study breakdown with accession lists

## VEP consequence types (high-impact)
- \`stop gained\` — premature stop codon (likely null allele)
- \`splice acceptor variant\` / \`splice donor variant\` — disrupts splicing
- \`frameshift variant\` — insertion/deletion causing frame shift
- \`start lost\` — loss of start codon

## Interpretation
- **EMS homozygous stop-gained** → confirmed null allele, suitable for phenotyping.
- **NAT heterozygous** → segregating natural LOF, useful for GWAS/association.
- \`genebank_url\` → direct link to order seed (ARS-GRIN, IRRI, ICRISAT).

## Fallbacks
- 0 LOF accessions → report explicitly. The gene may be essential (LOF never
  recovered), not yet surveyed, or outside the species where VEP data is
  dense. VEP coverage is richest for sorghum.`,
  },

  pav_cnv: {
    definition: {
      name: "pav_cnv",
      title: "Presence/absence variation (PAV) and copy-number variation (CNV)",
      description:
        "Detect gene presence/absence and copy-number variation across an assembly panel, " +
        "either by faceting on system_name or via a chained graph traversal that includes " +
        "neighborhood context.",
      arguments: [
        { name: "gene_id", description: "Query gene stable ID (or rice ortholog ID) for seeding.", required: true },
        { name: "taxon_id", description: "Plain NCBI taxon ID of the target species (e.g. 4558).", required: true },
      ],
    },
    template: `# Workflow: PAV and CNV

**Query gene:** {{gene_id}}
**Species (NCBI taxon):** {{taxon_id}}

Two approaches — start with the basic faceting variant for direct PAV/CNV
questions; use the chained-graph variant when you also want ±10-gene
neighborhood context, or to seed from any homolog rather than the gene tree.

**Caveat:** not all genomes participated in the Compara gene tree analysis.
Always check the \`maps\` MongoDB collection (\`in_compara: true\`) to get
the genomes that *should* have homology data — that is the denominator when
interpreting absence.

**Faceting field:** prefer \`system_name\` (already human-readable).
Faceting on \`taxon_id\` works but yields NCBI integer IDs that need a second
lookup against the mongo \`taxonomy\` collection to render species names.

## Variant A — Basic faceting on system_name

\`\`\`
# 1. Get the gene tree
solr_search(q: "id:{{gene_id}}",
            fl: "id,gene_tree,homology__all_orthologs")
  → extract gene_tree id

# 2. Genomes that participated in Compara (denominator)
mongo_find(collection: "maps", filter: { in_compara: true },
           projection: { _id: 1, name: 1, system_name: 1 })

# 3. Facet members of the family by genome
solr_search(q: "gene_tree:<tree_id>", rows: 0,
            facet: { field: "system_name", mincount: 0, limit: -1 })
\`\`\`

Interpret per genome:
- count=0 (or absent from facet, with in_compara=true) → PAV (gene absent)
- count=1 → single copy
- count>1 → duplication / CNV

## Variant B — Chained graph traversal (neighborhood + CNV)

Two graph queries — the first expands to the family, the second to the
±10-gene neighborhood of every family member, filtered to one species.

\`\`\`
# 1. Family expansion: orthologs of the seed gene
solr_graph(
  from: "homology__all_orthologs",
  to:   "id",
  seed_q: "id:{{gene_id}}",
  fl: "id,gene_tree,system_name"
)
  → collect all family member ids

# 2. Neighborhood traversal in the target species, faceted by system_name
solr_graph(
  from:   "compara_neighbors_10",
  to:     "compara_idx_multi",
  seed_q: "id:(<family_member_ids joined with OR>)",
  fq:     ["taxonomy__ancestors:{{taxon_id}}"],
  fl:     "id,name,system_name,gene_tree"
)
  → counts per system_name reveal copy number per genome
\`\`\`

(Equivalent single-query form is also possible via solr_search with a {!graph}
prefix and facet.pivot on gene_tree,system_name; see solr_search description.)

## Interpretation
- count=1 across all in_compara genomes → single-copy conserved gene.
- Missing from the result AND in_compara=true → PAV (gene absent).
- count>1 in any genome → tandem duplication / CNV.

To seed from a rice ortholog (cross-species neighborhood), look up the rice
gene's tree ID first and use it as the seed in step 2.`,
  },

  gene_family_expansion: {
    definition: {
      name: "gene_family_expansion",
      title: "Gene family expansion / contraction across clades",
      description:
        "Compare per-clade copy counts of a gene family (gene tree) using a single faceted " +
        "Solr query. Useful for spotting lineage-specific expansions (e.g. tandem duplicates " +
        "in maize) or contractions (single-copy in eudicots, multi-copy in grasses).",
      arguments: [
        { name: "family", description: "Gene family or protein family name (e.g. 'lipoxygenase'), OR a gene_tree ID if already known.", required: true },
      ],
    },
    template: `# Workflow: Gene family expansion / contraction

**Family or gene_tree:** {{family}}

## Step 1 — Resolve to a gene tree

If the input is already a gene_tree ID, skip to Step 2. Otherwise:

\`\`\`
solr_suggest(term: "{{family}}")
  → among the results pick the candidate with the LARGEST num_genes whose
    fq_field is gene_tree, domains__ancestors, or pathways__ancestors.
    InterPro/domain matches often give the cleanest scope.
\`\`\`

## Step 2 — Per-clade copy counts in a single faceted query

\`\`\`
solr_search(
  q: "<fq_field>:<fq_value>",         # gene_tree:<id> or domains__ancestors:<id>
  rows: 0,
  facet: { field: "taxonomy__ancestors", mincount: 1, limit: -1 }
)
\`\`\`

Faceting on \`taxonomy__ancestors\` returns counts at every level of the
NCBI taxonomy under the family — species, genus, family, order, clade — in
the same response. That hierarchical view makes expansion / contraction
patterns visible without one query per genome.

## Step 3 — Resolve taxon IDs to names

\`\`\`
mongo_lookup_by_ids(
  collection: "taxonomy",
  ids: <facet integer keys>
)
  → join names/ranks back onto the counts
\`\`\`

## Step 4 — (Optional) Per-genome breakdown for a specific clade

\`\`\`
solr_search(
  q: "<fq_field>:<fq_value>",
  fq: ["taxonomy__ancestors:<clade NCBI id>"],
  rows: 0,
  facet: { field: "system_name", mincount: 0, limit: -1 }
)
\`\`\`

## Interpretation

- A clade with mean count substantially higher than its sibling clades →
  lineage-specific expansion (often whole-genome or tandem duplication).
- A clade with single-copy across all members while siblings are multi-copy
  → contraction (gene loss after duplication).
- Highly variable per-genome counts within one clade → PAV / CNV; switch to
  the \`pav_cnv\` workflow.

## Fallbacks

- 0 hits → name didn't resolve to anything indexed; broaden the suggest term
  or try \`q='name:"<exact term>"'\`.
- Counts only at the species level (no intermediate ranks) → the family may
  be confined to one genus; that's an answer in itself.`,
  },

  qtl_discovery: {
    definition: {
      name: "qtl_discovery",
      title: "Trait → QTL discovery (find QTLs by trait name)",
      description:
        "Resolve a free-text trait to a Trait Ontology term and return matching QTL records " +
        "(coordinates, populations, references). Use this before qtl_candidate_ranking when " +
        "you start from a trait name rather than a known interval.",
      arguments: [
        { name: "trait", description: "Free-text trait name, e.g. 'plant height' or 'rust resistance'.", required: true },
        { name: "species", description: "Optional species name to scope the QTL set.", required: false },
      ],
    },
    template: `# Workflow: Trait → QTL discovery

**Trait:** {{trait}}
**Species filter:** {{species}}

## Step 1 — Resolve the trait to a TO term

\`\`\`
solr_suggest(
  q:  'name:"{{trait}}"',
  fq: ['category:Trait Ontology']
)
  → returns one or more matches; each has fq_field=TO__ancestors and
    fq_value=<TO integer id>. Note also the canonical TO:NNNNNNN string.
\`\`\`

If the exact name doesn't match, fall back to a fuzzy term lookup:
\`\`\`
solr_suggest(term: "{{trait}}", fq: ['category:Trait Ontology'])
\`\`\`

## Step 2 — List QTLs annotated with that TO term

\`\`\`
mongo_find(
  collection: "qtls",
  filter: { "terms": "TO:NNNNNNN" }
)
  → each record has location.region, location.start, location.end,
    population/cross details, and source publications.
\`\`\`

To restrict to one species, intersect with the species' assemblies via the
\`maps\` collection or filter the QTL records themselves if they carry a
taxon field:
\`\`\`
mongo_find(collection: "maps",
           filter: { "taxon_id": <plain NCBI id> },
           projection: { _id: 1, name: 1, system_name: 1 })
\`\`\`

## Step 3 — (Optional) Find genes inside those QTL intervals

The Solr \`QTL_TO__ancestors\` field on each gene holds the QTL stable IDs
whose interval overlaps that gene. Use it to jump straight from a QTL to its
candidate genes — no coordinate math required:

\`\`\`
solr_search(
  q:  "QTL_TO__ancestors:<qtl_id>",
  fq: ["taxonomy__ancestors:<plain NCBI id>"],
  fl: "id,name,description,closest_rep_name,model_rep_name"
)
\`\`\`

To pre-filter to QTL-annotated genes for a trait without a specific QTL ID:
\`\`\`
solr_search(
  fq: ["TO__ancestors:<TO int>", "capabilities:QTL_TO",
       "taxonomy__ancestors:<plain NCBI id>"]
)
\`\`\`

## Step 4 — (Optional) Hand off to QTL candidate ranking

For each QTL of interest, load the \`qtl_candidate_ranking\` workflow with
the resolved \`region\`, \`start\`, \`end\`, and the plain NCBI \`taxon_id\`.

## Output

Render a table with columns: \`Trait | TO term | QTL ID | Region | Span (bp)
| Population | Reference\`. Group rows by trait if multiple TO matches were
returned.

## Fallbacks

- No TO match → broaden to a \`term=\` fuzzy lookup, or check synonyms in
  the TO collection: \`mongo_find(collection:"TO", filter:{"synonyms": …})\`.
- 0 QTLs for a valid TO term → the trait is annotated but no QTL has been
  cataloged in Gramene for it. Surface that explicitly.`,
  },
};

const PROMPTS = Object.values(PROMPT_REGISTRY).map((p) => p.definition);

function getPromptMessages(name, args = {}) {
  const entry = PROMPT_REGISTRY[name];
  if (!entry) throw new Error(`Unknown prompt: ${name}`);

  // Validate required arguments.
  const defArgs = entry.definition.arguments || [];
  for (const spec of defArgs) {
    if (spec.required && (args[spec.name] === undefined || args[spec.name] === null || args[spec.name] === "")) {
      throw new Error(`Missing required argument '${spec.name}' for prompt '${name}'`);
    }
  }

  const text = renderTemplate(entry.template, args);
  return {
    description: entry.definition.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

// --- MCP request handler ---
async function handleJsonRpc(msg, sessionId = null) {
  const { jsonrpc, id, method, params } = msg || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }

  // Lifecycle
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {
        tools: SERVER_CAPABILITIES.tools,
        prompts: SERVER_CAPABILITIES.prompts,
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === "notifications/initialized") {
    return id !== undefined ? jsonRpcResult(id, {}) : null;
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  // Tools
  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: toolArgs } = params || {};
    if (!name || typeof name !== "string") {
      return jsonRpcError(id, -32602, "Invalid params: missing tool name");
    }

    const entry = TOOL_REGISTRY[name];
    if (!entry) {
      log({ event: "tool_call", tool: name, status: "unknown_tool" });
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
    }

    const t0 = Date.now();
    try {
      const result = await entry.handler(toolArgs);
      log({ event: "tool_call", tool: name, args: toolArgs, status: "ok", ms: Date.now() - t0, ...(sessionId && { session: sessionId }) });
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      log({ event: "tool_call", tool: name, args: toolArgs, status: "error", error: e?.message || String(e), ms: Date.now() - t0, ...(sessionId && { session: sessionId }) });
      return jsonRpcError(id, -32000, `Tool error: ${e?.message || String(e)}`);
    }
  }

  // Prompts
  if (method === "prompts/list") {
    return jsonRpcResult(id, { prompts: PROMPTS });
  }

  if (method === "prompts/get") {
    const { name, arguments: promptArgs } = params || {};
    if (!name || typeof name !== "string") {
      return jsonRpcError(id, -32602, "Invalid params: missing prompt name");
    }
    if (!PROMPT_REGISTRY[name]) {
      log({ event: "prompt_get", prompt: name, status: "unknown_prompt" });
      return jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
    }
    try {
      const result = getPromptMessages(name, promptArgs || {});
      log({ event: "prompt_get", prompt: name, args: promptArgs, status: "ok", ...(sessionId && { session: sessionId }) });
      return jsonRpcResult(id, result);
    } catch (e) {
      log({ event: "prompt_get", prompt: name, args: promptArgs, status: "error", error: e?.message || String(e), ...(sessionId && { session: sessionId }) });
      return jsonRpcError(id, -32602, e?.message || String(e));
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// --- Dashboard HTML ---
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gramene MCP Usage</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f7fa;color:#1a1a2e;padding:24px}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:4px;color:#1a1a2e}
  .subtitle{font-size:.85rem;color:#666;margin-bottom:24px}
  .cards{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:28px}
  .card{background:#fff;border-radius:10px;padding:18px 22px;flex:1;min-width:140px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .card .label{font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:.05em}
  .card .value{font-size:2rem;font-weight:700;margin-top:4px;color:#2563eb}
  .card .value.warn{color:#dc2626}
  section{background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  section h2{font-size:1rem;font-weight:600;margin-bottom:16px;color:#374151}
  .bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:.85rem}
  .bar-label{width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151}
  .bar-track{flex:1;background:#e5e7eb;border-radius:4px;height:18px;overflow:hidden}
  .bar-fill{height:100%;background:#2563eb;border-radius:4px;transition:width .4s}
  .bar-fill.has-errors{background:#f59e0b}
  .bar-count{width:80px;text-align:right;color:#6b7280}
  .bar-ms{width:70px;text-align:right;color:#9ca3af;font-size:.78rem}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{text-align:left;padding:6px 10px;border-bottom:2px solid #e5e7eb;color:#6b7280;font-weight:600;font-size:.75rem;text-transform:uppercase}
  td{padding:6px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-family:monospace}
  td.tool{font-weight:600;color:#1d4ed8;font-family:system-ui,sans-serif}
  td.session{font-size:.75rem;color:#6b7280;font-family:monospace}
  td.ok{color:#16a34a}td.error{color:#dc2626}
  tr:hover td{background:#f9fafb}
  .meta{font-size:.78rem;color:#9ca3af;margin-top:12px;text-align:right}
  .refresh{font-size:.78rem;color:#6b7280;float:right;margin-top:-2px}
  .args{max-width:380px;white-space:pre-wrap;word-break:break-all;color:#4b5563;font-size:.75rem}
</style>
</head>
<body>
<h1>Gramene MCP — Usage Dashboard</h1>
<p class="subtitle" id="subtitle">Loading…</p>
<div class="cards" id="cards"></div>
<section>
  <h2>Calls by Tool <span class="refresh" id="countdown"></span></h2>
  <div id="bars"></div>
</section>
<section>
  <h2>Sessions <span style="font-size:.8rem;font-weight:400;color:#9ca3af">(last 50 active)</span></h2>
  <table><thead><tr><th>Session ID</th><th>Started</th><th>Last Active</th><th>Calls</th><th>Errors</th><th>Tools Used</th></tr></thead>
  <tbody id="sessions"></tbody></table>
</section>
<section>
  <h2>Recent Calls (last 100)</h2>
  <table><thead><tr><th>Time</th><th>Session</th><th>Tool</th><th>Status</th><th>ms</th><th>Args</th></tr></thead>
  <tbody id="recent"></tbody></table>
</section>
<p class="meta" id="meta"></p>
<script>
let countdown = 30;
async function load() {
  try {
    const d = await fetch('/mcp/usage/data').then(r => r.json());
    document.getElementById('subtitle').textContent =
      new Date().toLocaleString() + ' — ' + d.total + ' total calls tracked (' + d.source + ')';

    document.getElementById('cards').innerHTML = [
      ['Total calls', d.total, false],
      ['Last hour', d.calls1h, false],
      ['Last 24h', d.calls24h, false],
      ['Error rate', d.errorRate + '%', d.errors > 0],
      ['Avg resp', d.avgMs + 'ms', false],
      ['Tools used', d.byTool.length, false],
    ].map(([label, value, warn]) =>
      '<div class="card"><div class="label">' + label + '</div>' +
      '<div class="value' + (warn ? ' warn' : '') + '">' + value + '</div></div>'
    ).join('');

    const maxCalls = d.byTool[0]?.calls || 1;
    document.getElementById('bars').innerHTML = d.byTool.map(t => {
      const pct = (t.calls / maxCalls * 100).toFixed(1);
      const hasErr = t.errors > 0;
      return '<div class="bar-row">' +
        '<div class="bar-label" title="' + t.tool + '">' + t.tool + '</div>' +
        '<div class="bar-track"><div class="bar-fill' + (hasErr ? ' has-errors' : '') +
          '" style="width:' + pct + '%"></div></div>' +
        '<div class="bar-count">' + t.calls + (t.errors ? ' <span style="color:#dc2626">(' + t.errors + ' err)</span>' : '') + '</div>' +
        '<div class="bar-ms">' + t.avgMs + 'ms</div>' +
        '</div>';
    }).join('');

    document.getElementById('sessions').innerHTML = (d.sessions||[]).length
      ? d.sessions.map(s => {
          const sid = s.session ? s.session.slice(0,8) + '…' : '—';
          const tools = Object.entries(s.tools).sort((a,b)=>b[1]-a[1]).map(([t,n])=>t+(n>1?'×'+n:'')).join(', ');
          return '<tr>' +
            '<td class="session" title="' + (s.session||'') + '">' + sid + '</td>' +
            '<td>' + new Date(s.firstSeen).toLocaleString() + '</td>' +
            '<td>' + new Date(s.lastSeen).toLocaleString() + '</td>' +
            '<td>' + s.calls + '</td>' +
            '<td class="' + (s.errors?'error':'ok') + '">' + (s.errors||'0') + '</td>' +
            '<td style="font-size:.78rem;color:#4b5563">' + tools + '</td>' +
            '</tr>';
        }).join('')
      : '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:16px">No session data yet — sessions are tracked via X-MCP-Session header</td></tr>';

    document.getElementById('recent').innerHTML = d.recent.map(e => {
      const args = e.args ? JSON.stringify(e.args, null, 0).slice(0, 200) : '';
      const t = new Date(e.ts).toLocaleString();
      const sid = e.session ? e.session.slice(0,8) + '…' : '—';
      return '<tr><td>' + t + '</td>' +
        '<td class="session" title="' + (e.session||'') + '">' + sid + '</td>' +
        '<td class="tool">' + (e.tool||'') + '</td>' +
        '<td class="' + (e.status==='ok'?'ok':'error') + '">' + e.status + '</td>' +
        '<td>' + (e.ms||'') + '</td>' +
        '<td class="args">' + args.replace(/</g,'&lt;') + '</td></tr>';
    }).join('');

    document.getElementById('meta').textContent =
      'Source: ' + d.source + (d.source==='memory' ? ' (' + d.buffered + ' events buffered)' : '') +
      ' · MCP_LOG_FILE ' + (d.source==='file' ? 'enabled' : 'not set — history lost on restart');
  } catch(e) {
    document.getElementById('subtitle').textContent = 'Error loading data: ' + e.message;
  }
}

function tick() {
  countdown--;
  document.getElementById('countdown').textContent = 'refreshing in ' + countdown + 's';
  if (countdown <= 0) { countdown = 30; load(); }
}

load();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  try {
    if (!originAllowed(req)) return send(res, 403, null);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Dashboard routes (GET only, no CORS restriction needed — read-only)
    if (url.pathname === "/mcp/usage" && req.method === "GET") {
      const html = dashboardHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }

    if (url.pathname === "/mcp/usage/data" && req.method === "GET") {
      const events = LOG_FILE ? await readLogFile() : logBuffer;
      const stats = computeStats(events);
      const body = JSON.stringify(stats);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(body);
    }

    if (url.pathname !== "/mcp") return send(res, 404, { error: "Not Found" });

    // GET /mcp — server discovery document. Returns capabilities, supported
    // protocol versions, transport, and auth mode without requiring an
    // initialize round-trip. Modeled on https://pubmed.caseyjhand.com/mcp.
    if (req.method === "GET") {
      return send(res, 200, getServerDiscoveryDoc(), {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
        "Cache-Control": "no-store",
      });
    }

    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });

    const msg = await readJson(req);

    // Session management: assign on initialize, validate on subsequent calls.
    let sessionId = req.headers["x-mcp-session"] || null;
    if (msg?.method === "initialize") {
      pruneOldSessions();
      sessionId = randomUUID();
      activeSessions.set(sessionId, { created: new Date().toISOString(), lastSeen: new Date().toISOString() });
      log({ event: "session_start", session: sessionId });
    } else {
      sessionId = getOrCreateSession(sessionId);
      if (sessionId) activeSessions.get(sessionId).lastSeen = new Date().toISOString();
    }

    const sessionHeaders = sessionId ? { "X-MCP-Session": sessionId } : {};
    const reply = await handleJsonRpc(msg, sessionId);

    if (reply === null) return send(res, 202, null, sessionHeaders);   // notification → no body
    return send(res, 200, reply, sessionHeaders);
  } catch (e) {
    return send(res, 400, jsonRpcError(null, -32700, "Parse error", String(e?.message || e)));
  }
});

// Eagerly load the metadata cache before the server starts accepting
// connections. This keeps first-call latency predictable and avoids racing
// tool calls against a half-populated cache.
try {
  console.error("Loading metadata cache…");
  await initMetadataCache();
  startCacheRefresh();
} catch (err) {
  console.error(`Metadata cache load failed: ${err?.message || err}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.error(`Gramene MCP server listening on http://${HOST}:${PORT}/mcp`);
});

// Graceful shutdown
async function shutdown() {
  console.error("Shutting down…");
  server.close();
  await mongoClient.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
