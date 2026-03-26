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
          description: "Data types available for this gene. Values include: 'expression' (RNA-seq data in the expression collection), 'pathways' (Plant Reactome annotation), 'homology' (Compara gene trees), 'pubs' (literature), 'regulation' (regulatory features), 'variation' (genetic variants). Use as a filter to restrict to genes with specific data: fq=['capabilities:expression']."
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
function compileGraphQuery(from, to, seedQuery, opts = {}) {
  if (!from || !to || !seedQuery) {
    throw new Error("graph query requires 'from', 'to', and 'seed_q'");
  }
  // Local param values must not contain whitespace or unescaped special chars.
  // Field names are safe; maxDepth is validated to be an integer.
  const localParams = { from, to };
  if (opts.maxDepth !== undefined) {
    const d = Number(opts.maxDepth);
    if (!Number.isInteger(d) || d < -1) throw new Error("maxDepth must be an integer >= -1");
    localParams.maxDepth = d;
  }
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
  if (taxon_id !== undefined) fq.push(`taxon_id:${Number(taxon_id)}`);
  if (mapFilter) fq.push(`map:${solrEscapeValue(mapFilter)}`);
  return solrFetch(SOLR_GENES_CORE, "select", { q, fq, fl, rows, sort });
}

async function tool_expression_for_genes(args) {
  const {
    gene_ids,
    experiment_type,  // "Baseline" | "Differential" | null (both)
    taxon_id,         // integer — filter experiments by species
    po_terms,         // int[] — PO term int_ids to filter assay tissues/conditions
  } = args || {};

  if (!Array.isArray(gene_ids) || gene_ids.length === 0) {
    throw new Error("expression_for_genes requires a non-empty 'gene_ids' array");
  }
  if (gene_ids.length > 500) {
    throw new Error("expression_for_genes: max 500 gene_ids per call");
  }

  const d = db();

  // 1. Get relevant experiments (filtered by type and/or taxon)
  const expFilter = {};
  if (experiment_type) expFilter.type = experiment_type;
  if (taxon_id !== undefined) expFilter.taxon_id = Number(taxon_id);
  const experiments = await d.collection("experiments").find(expFilter).toArray();
  const relevantExpIds = new Set(experiments.map((e) => e._id));
  const expMap = Object.fromEntries(experiments.map((e) => [e._id, e]));

  // 2. Get expression docs for the requested gene IDs
  const expDocs = await d.collection("expression")
    .find({ _id: { $in: gene_ids } })
    .toArray();

  // 3. Collect assay IDs needed (only for relevant experiments, non-empty groups)
  const neededAssayIds = new Set();
  for (const doc of expDocs) {
    for (const [expId, groups] of Object.entries(doc)) {
      if (expId === "_id" || !relevantExpIds.has(expId)) continue;
      if (!Array.isArray(groups) || groups.length === 0) continue;
      for (const g of groups) {
        if (g.group) neededAssayIds.add(`${expId}.${g.group}`);
      }
    }
  }

  // 4. Fetch assay metadata, optionally filtered by PO terms
  const assayFilter = { _id: { $in: [...neededAssayIds] } };
  if (po_terms && po_terms.length > 0) {
    const poInts = po_terms.map(Number);
    assayFilter.$or = [
      { "characteristic.int_id": { $in: poInts } },
      { "factor.int_id": { $in: poInts } },
    ];
  }
  const assayDocs = await d.collection("assays").find(assayFilter).toArray();
  const assayMap = Object.fromEntries(assayDocs.map((a) => [a._id, a]));
  const relevantAssayIds = new Set(assayDocs.map((a) => a._id));

  // Helper: extract a tissue label and extra condition string from an assay
  function assayLabels(assay) {
    if (!assay) return { tissue: null, condition: null };
    const tissue =
      assay.factor?.find((f) => f.type === "organism part")?.label ??
      assay.characteristic?.find((c) => c.type === "organism part")?.label ??
      null;
    const condParts = (assay.factor ?? [])
      .filter((f) => f.type !== "organism part")
      .map((f) => `${f.type}:${f.label}`);
    return { tissue, condition: condParts.length ? condParts.join(", ") : null };
  }

  // 5. Build per-gene result
  const genes = {};
  for (const doc of expDocs) {
    const geneId = doc._id;
    const baseline = [];
    const differential = [];

    for (const [expId, groups] of Object.entries(doc)) {
      if (expId === "_id" || !relevantExpIds.has(expId)) continue;
      if (!Array.isArray(groups) || groups.length === 0) continue;

      const exp = expMap[expId];
      for (const g of groups) {
        const assayId = g.group ? `${expId}.${g.group}` : null;

        // When PO filtering is active, skip assay groups that did not match
        if (po_terms?.length > 0 && assayId && !relevantAssayIds.has(assayId)) continue;

        const { tissue, condition } = assayLabels(assayId ? assayMap[assayId] : null);

        if (g.value !== undefined) {
          baseline.push({
            experiment: expId,
            experiment_name: exp?.name ?? null,
            group: g.group,
            value: g.value,
            tissue,
            condition,
          });
        } else if (g.l2fc !== undefined) {
          differential.push({
            experiment: expId,
            experiment_name: exp?.name ?? null,
            group: g.group,
            l2fc: g.l2fc,
            p_value: g.p_value ?? null,
            tissue,
            condition,
          });
        }
      }
    }

    genes[geneId] = { baseline, differential };
  }

  return {
    gene_count: Object.keys(genes).length,
    experiment_count: experiments.length,
    genes,
  };
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
    maxDepth = 1,
    traversalFilter,
    returnRoot = true,
    fq,
    fl,
    rows = 100,
    start = 0,
    sort,
  } = args || {};

  const q = compileGraphQuery(from, to, seed_q, { maxDepth, traversalFilter, returnRoot });
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
        `Search the Solr suggestions core (${SOLR_SUGGESTIONS_CORE}) via /suggest endpoint.`,
        `Pass 'term' for a simple search — the tool builds the standard Gramene boost query automatically:`,
        `  {!boost b=relevance}name:<t>^5 ids:<t>^5 ids:<t>*^3 synonym:<t>^3 synonym:<t>*^2 text:<t>*^1`,
        `Each result document includes fq_field and fq_value fields that can be used as filter`,
        `queries against the genes core (e.g. fq_field=taxonomy__ancestors, fq_value=3702).`,
        `Pass 'q' instead of 'term' to supply a raw Solr query string.`,
        ``,
        `IMPORTANT — looking up pathways and species:`,
        `  'term' searches across all categories (InterPro, GO, Taxonomy, Reactome, etc.) and ranks`,
        `  by relevance. Pathway and species terms often do NOT appear in the top results because`,
        `  InterPro/GO terms dominate. Use 'q' with an exact name match instead:`,
        `    Pathway: q='name:"Jasmonic acid biosynthesis"'  → fq_field=pathways__ancestors`,
        `    Species: q='name:"Sorghum bicolor"'             → fq_field=taxonomy__ancestors`,
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
      description: "Run a MongoDB find() query on a collection. Supports filter, projection, sort, limit, and skip.",
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
        `Traverse a graph of gene relationships in the Solr genes core using the {!graph} query parser.`,
        `Each document in the index has a node ID field ('to') and an adjacency field ('from') listing`,
        `the IDs of related documents. The traversal starts from a seed query and follows edges up to maxDepth hops.`,
        ``,
        `Common field pairs:`,
        `  Genomic neighborhood (±10 flanking genes):`,
        `    from=compara_neighbors_10  to=compara_idx_multi`,
        `    seed_q=gene_tree:<id>  or  seed_q=id:<gene_id>`,
        `  Both fields are pint (integer) — compara_idx_multi holds each gene's compara index,`,
        `  and compara_neighbors_10 holds the compara_idx_multi values of its ±10 flanking genes.`,
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
          maxDepth: {
            type: "integer",
            minimum: -1,
            description: "Maximum traversal depth. 1 = direct neighbors only. -1 = unlimited. Default: 1.",
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
        `Key fields to request via 'fl':`,
        `  id, name, biotype, start, end, strand, system_name, taxon_id`,
        `  gene_tree, compara_idx_multi  — for graph traversal to find conserved neighbors`,
        `  TO__ancestors, GO__ancestors  — for ontology-based scoring`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          region:   { type: "string",  description: "Chromosome / scaffold name (e.g. '6', 'Chr01')." },
          start:    { type: "integer", description: "Interval start coordinate (bp, inclusive)." },
          end:      { type: "integer", description: "Interval end coordinate (bp, inclusive)." },
          taxon_id: { type: "integer", description: "Filter by NCBI taxon ID (e.g. 4558 for Sorghum bicolor)." },
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
        `Retrieve expression data for a list of gene IDs from the MongoDB expression collection,`,
        `joined with assay (tissue/condition) and experiment metadata.`,
        ``,
        `Each gene in the result has:`,
        `  baseline[]    — {experiment, experiment_name, group, value, tissue, condition}`,
        `                  value is TPM/FPKM from Baseline experiments`,
        `  differential[] — {experiment, experiment_name, group, l2fc, p_value, tissue, condition}`,
        `                   from Differential experiments`,
        ``,
        `Use po_terms (integer PO term IDs) to restrict results to specific tissues.`,
        `Common PO int IDs: 9001=grain/fruit, 9089=endosperm, 25034=leaf, 20127=stem,`,
        `                   7010=germination stage, 7016=flowering stage.`,
        `Use experiment_type='Baseline' or 'Differential' to limit scope.`,
        `Include orthologs (from solr_graph results) in gene_ids to compare expression`,
        `across species for conserved candidate prioritization.`,
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
};

const TOOLS = Object.values(TOOL_REGISTRY).map((t) => t.definition);

// --- MCP request handler ---
async function handleJsonRpc(msg, sessionId = null) {
  const { jsonrpc, id, method, params } = msg || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }

  // Lifecycle
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "gramene-mcp", version: "0.3.0" },
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
            '<td>' + new Date(s.lastSeen).toLocaleTimeString() + '</td>' +
            '<td>' + s.calls + '</td>' +
            '<td class="' + (s.errors?'error':'ok') + '">' + (s.errors||'0') + '</td>' +
            '<td style="font-size:.78rem;color:#4b5563">' + tools + '</td>' +
            '</tr>';
        }).join('')
      : '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:16px">No session data yet — sessions are tracked via X-MCP-Session header</td></tr>';

    document.getElementById('recent').innerHTML = d.recent.map(e => {
      const args = e.args ? JSON.stringify(e.args, null, 0).slice(0, 200) : '';
      const t = new Date(e.ts).toLocaleTimeString();
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
