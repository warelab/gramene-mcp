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
        // Literature cross-references
        "PUBMED__xrefs": {
          type: "string[]",
          description: "PubMed cross-references for this gene. Values are PMID strings (e.g. '31597271') or DOI strings prefixed with 'DOI:' (e.g. 'DOI:10.1016/j.cj.2016.06.014'). Only present on genes with capabilities:pubs. Use the pubmed_for_genes tool to resolve these to full paper metadata (title, authors, abstract)."
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

// --- Enrichment analysis helpers: hypergeometric test + multiple testing ---

// Log-gamma via Lanczos approximation (sufficient precision for enrichment p-values)
function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function lnBinomial(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
}

/**
 * Hypergeometric survival function: P(X >= k)
 * N = population size (background), K = successes in population (bg with term),
 * n = draws (foreground size), k = observed successes (fg with term).
 */
function hypergeomSF(k, N, K, n) {
  if (k <= 0) return 1;
  const maxI = Math.min(K, n);
  if (k > maxI) return 0;

  // Sum P(X = i) for i = k..min(K,n) using log-space for numerical stability
  const lnDenom = lnBinomial(N, n);
  let pSum = 0;
  for (let i = k; i <= maxI; i++) {
    const lnP = lnBinomial(K, i) + lnBinomial(N - K, n - i) - lnDenom;
    pSum += Math.exp(lnP);
    if (pSum > 1) return 1; // numerical ceiling
  }
  return Math.min(pSum, 1);
}

/**
 * Benjamini–Hochberg FDR correction.
 * Takes array of {p, ...rest}, returns same with added `p_adjusted` field.
 */
function benjaminiHochberg(results) {
  const m = results.length;
  if (m === 0) return results;
  // Sort by raw p ascending
  const indexed = results.map((r, i) => ({ ...r, _origIdx: i }));
  indexed.sort((a, b) => a.p - b.p);
  // Step-up: p_adj[i] = min( p[i] * m / (i+1), p_adj[i+1] )
  indexed[m - 1].p_adjusted = Math.min(indexed[m - 1].p * m / m, 1);
  for (let i = m - 2; i >= 0; i--) {
    indexed[i].p_adjusted = Math.min(indexed[i].p * m / (i + 1), indexed[i + 1].p_adjusted, 1);
  }
  // Restore original order
  const out = new Array(m);
  for (const r of indexed) {
    const { _origIdx, ...rest } = r;
    out[_origIdx] = rest;
  }
  return out;
}

/**
 * Parse Solr flat facet field response: [value, count, value, count, ...]
 * into a Map of value → count.
 */
function parseFacetField(arr) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (let i = 0; i < arr.length; i += 2) {
    const val = arr[i];
    const cnt = arr[i + 1];
    if (cnt > 0) map.set(val, cnt);
  }
  return map;
}

async function tool_enrichment_analysis(args) {
  const {
    foreground_fq,
    background_fq,
    field = "GO__ancestors",
    p_threshold = 0.05,
    correction = "bh",
    min_foreground_count = 2,
    max_terms = 200,
    include_ancestors = false,
  } = args || {};

  if (!Array.isArray(foreground_fq) || foreground_fq.length === 0) {
    throw new Error("enrichment_analysis requires a non-empty 'foreground_fq' array");
  }
  if (!Array.isArray(background_fq) || background_fq.length === 0) {
    throw new Error("enrichment_analysis requires a non-empty 'background_fq' array");
  }

  // Allowed ontology/annotation fields for enrichment
  const ALLOWED_FIELDS = new Set([
    "GO__ancestors", "PO__ancestors", "TO__ancestors",
    "domains__ancestors", "pathways__ancestors",
  ]);
  if (!ALLOWED_FIELDS.has(field)) {
    throw new Error(`enrichment_analysis: field must be one of ${[...ALLOWED_FIELDS].join(", ")}`);
  }

  // The corresponding MongoDB collection for term name lookups
  const FIELD_TO_COLLECTION = {
    "GO__ancestors":        "GO",
    "PO__ancestors":        "PO",
    "TO__ancestors":        "TO",
    "domains__ancestors":   "domains",
    "pathways__ancestors":  "pathways",
  };

  // 1. Foreground facet: all terms in the foreground set
  const fgResp = await solrFetch(SOLR_GENES_CORE, "select", {
    q: "*:*",
    fq: [...foreground_fq, `${field}:[* TO *]`], // must have at least one term
    rows: 0,
    facet: { field, mincount: 1, limit: -1 },
  });
  const fgTotal = fgResp?.response?.numFound ?? 0;
  const fgFacets = parseFacetField(
    fgResp?.facet_counts?.facet_fields?.[field]
  );

  if (fgTotal === 0) {
    return { error: "No foreground genes found matching the filters.", foreground_count: 0 };
  }

  // 2. Background facet: all terms in the background set
  const bgResp = await solrFetch(SOLR_GENES_CORE, "select", {
    q: "*:*",
    fq: [...background_fq, `${field}:[* TO *]`],
    rows: 0,
    facet: { field, mincount: 1, limit: -1 },
  });
  const bgTotal = bgResp?.response?.numFound ?? 0;
  const bgFacets = parseFacetField(
    bgResp?.facet_counts?.facet_fields?.[field]
  );

  if (bgTotal === 0) {
    return { error: "No background genes found matching the filters.", background_count: 0 };
  }

  // 3. Compute hypergeometric p-value for each foreground term
  let results = [];
  for (const [termId, fgCount] of fgFacets.entries()) {
    if (fgCount < min_foreground_count) continue;
    const bgCount = bgFacets.get(termId) || 0;
    if (bgCount === 0) continue; // shouldn't happen but guard

    const p = hypergeomSF(fgCount, bgTotal, bgCount, fgTotal);
    const foldEnrichment = (fgCount / fgTotal) / (bgCount / bgTotal);

    results.push({
      term_id: Number(termId),
      foreground_count: fgCount,
      foreground_fraction: parseFloat((fgCount / fgTotal).toFixed(4)),
      background_count: bgCount,
      background_fraction: parseFloat((bgCount / bgTotal).toFixed(4)),
      fold_enrichment: parseFloat(foldEnrichment.toFixed(2)),
      p,
    });
  }

  // 4. Multiple testing correction
  if (correction === "bh" || correction === "benjamini-hochberg") {
    results = benjaminiHochberg(results);
  } else {
    // Bonferroni
    const m = results.length;
    for (const r of results) {
      r.p_adjusted = Math.min(r.p * m, 1);
    }
  }

  // 5. Filter by adjusted p-value threshold, sort by p_adjusted
  results = results
    .filter((r) => r.p_adjusted <= p_threshold)
    .sort((a, b) => a.p_adjusted - b.p_adjusted);

  // Cap at max_terms
  if (results.length > max_terms) results = results.slice(0, max_terms);

  // Round p-values for readable output
  for (const r of results) {
    r.p = parseFloat(r.p.toExponential(3));
    r.p_adjusted = parseFloat(r.p_adjusted.toExponential(3));
  }

  // 6. Look up term names from MongoDB (and build DAG if requested)
  const collName = FIELD_TO_COLLECTION[field];
  const d = db();
  const enrichedIds = new Set(results.map((r) => r.term_id));

  if (results.length > 0) {
    if (include_ancestors) {
      // Collect all ancestor IDs from enriched terms
      const allAncestorIds = new Set();
      // First fetch enriched term docs to get their ancestors arrays
      const enrichedDocs = await d.collection(collName)
        .find({ _id: { $in: [...enrichedIds] } })
        .toArray();
      for (const doc of enrichedDocs) {
        if (Array.isArray(doc.ancestors)) {
          doc.ancestors.forEach((a) => allAncestorIds.add(a));
        }
        allAncestorIds.add(doc._id);
      }

      // Fetch all ancestor terms (many may already be in enrichedDocs)
      const missingIds = [...allAncestorIds].filter((id) => !enrichedIds.has(id));
      const ancestorDocs = missingIds.length > 0
        ? await d.collection(collName)
            .find({ _id: { $in: missingIds } })
            .toArray()
        : [];

      const allDocs = [...enrichedDocs, ...ancestorDocs];
      const docMap = Object.fromEntries(allDocs.map((t) => [t._id, t]));

      // Attach names to enriched results
      for (const r of results) {
        r.term_name = docMap[r.term_id]?.name || null;
      }

      // Build enrichment lookup for quick access
      const enrichmentMap = Object.fromEntries(results.map((r) => [r.term_id, r]));

      // Build DAG nodes — each node has id, name, namespace, is_a (parents),
      // children (derived), and enrichment stats if significant
      const dagNodes = {};
      const childrenMap = {};  // parent_id → Set of child_ids

      for (const doc of allDocs) {
        const id = doc._id;
        const parents = Array.isArray(doc.is_a) ? doc.is_a.filter((p) => allAncestorIds.has(p)) : [];
        const node = {
          id,
          name: doc.name || `${field.replace("__ancestors","")}:${id}`,
          namespace: doc.namespace || null,
          is_a: parents,
          children: [],
        };
        if (enrichmentMap[id]) {
          node.enriched = true;
          node.fold_enrichment = enrichmentMap[id].fold_enrichment;
          node.p_adjusted = enrichmentMap[id].p_adjusted;
          node.foreground_count = enrichmentMap[id].foreground_count;
          node.background_count = enrichmentMap[id].background_count;
        }
        dagNodes[id] = node;

        for (const pid of parents) {
          if (!childrenMap[pid]) childrenMap[pid] = new Set();
          childrenMap[pid].add(id);
        }
      }

      // Wire up children arrays
      for (const [pid, kids] of Object.entries(childrenMap)) {
        if (dagNodes[pid]) dagNodes[pid].children = [...kids].sort((a, b) => a - b);
      }

      // Identify roots: nodes with no parents within the DAG
      const roots = Object.values(dagNodes)
        .filter((n) => n.is_a.length === 0)
        .map((n) => n.id)
        .sort((a, b) => a - b);

      // Return with DAG
      return {
        foreground_count: fgTotal,
        background_count: bgTotal,
        field,
        correction,
        p_threshold,
        terms_tested: fgFacets.size,
        significant_terms: results.length,
        terms: results,
        dag: {
          node_count: Object.keys(dagNodes).length,
          root_ids: roots,
          nodes: dagNodes,
        },
      };
    } else {
      // No DAG requested — just resolve names
      const termDocs = await d.collection(collName)
        .find({ _id: { $in: [...enrichedIds] } }, { projection: { _id: 1, name: 1 } })
        .toArray();
      const nameMap = Object.fromEntries(termDocs.map((t) => [t._id, t.name]));
      for (const r of results) {
        r.term_name = nameMap[r.term_id] || null;
      }
    }
  }

  return {
    foreground_count: fgTotal,
    background_count: bgTotal,
    field,
    correction,
    p_threshold,
    terms_tested: fgFacets.size,
    significant_terms: results.length,
    terms: results,
  };
}

// --- PubMed / literature helpers ---

const NCBI_ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const NCBI_ESEARCH_URL  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const NCBI_EFETCH_URL   = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

/**
 * Fetch paper summaries from NCBI E-utilities for a list of PMIDs.
 * Returns a Map<pmid_string, {pmid, title, authors, journal, pubdate, doi, url}>.
 * Batches up to 200 per request.
 */
async function fetchPubmedSummaries(pmids) {
  const results = new Map();
  if (!pmids.length) return results;
  const BATCH = 200;
  for (let i = 0; i < pmids.length; i += BATCH) {
    const batch = pmids.slice(i, i + BATCH);
    const url = `${NCBI_ESUMMARY_URL}?db=pubmed&id=${batch.join(",")}&retmode=json`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    if (!data.result) continue;
    for (const uid of (data.result.uids || [])) {
      const rec = data.result[uid];
      if (!rec || rec.error) continue;
      let doi = "";
      if (rec.elocationid) {
        const m = rec.elocationid.match(/doi:\s*(10\.\S+)/i);
        if (m) doi = m[1];
      }
      if (!doi && rec.articleids) {
        const d = rec.articleids.find(a => a.idtype === "doi");
        if (d) doi = d.value;
      }
      results.set(String(uid), {
        pmid: String(uid),
        title: rec.title || "",
        authors: (rec.authors || []).map(a => a.name),
        journal: rec.source || rec.fulljournalname || "",
        pubdate: rec.pubdate || "",
        doi,
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      });
    }
  }
  return results;
}

/**
 * Resolve DOIs to PMIDs via NCBI esearch.  Returns Map<doi, pmid_string>.
 */
async function resolveDoisToPmids(dois) {
  const result = new Map();
  if (!dois.length) return result;
  // esearch one-at-a-time (DOIs can't reliably be batched in a single term query)
  for (const doi of dois.slice(0, 50)) {  // cap at 50 to stay polite
    try {
      const url = `${NCBI_ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const ids = data?.esearchresult?.idlist;
      if (ids && ids.length === 1) {
        result.set(doi, ids[0]);
      }
    } catch (_) { /* skip failed lookups */ }
  }
  return result;
}

/**
 * Fetch abstracts for a list of PMIDs.  Returns Map<pmid_string, abstract_text>.
 */
async function fetchPubmedAbstracts(pmids) {
  const results = new Map();
  if (!pmids.length) return results;
  const BATCH = 50;
  for (let i = 0; i < pmids.length; i += BATCH) {
    const batch = pmids.slice(i, i + BATCH);
    try {
      const url = `${NCBI_EFETCH_URL}?db=pubmed&id=${batch.join(",")}&rettype=xml&retmode=xml`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      // Simple XML extraction of AbstractText elements per PMID
      const articleRegex = /<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g;
      let match;
      while ((match = articleRegex.exec(xml)) !== null) {
        const article = match[0];
        const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);
        if (!pmidMatch) continue;
        const pmid = pmidMatch[1];
        // Collect all AbstractText segments
        const absTexts = [];
        const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
        let absMatch;
        while ((absMatch = absRegex.exec(article)) !== null) {
          // Strip inline XML tags (e.g. <i>, <b>, <sup>)
          absTexts.push(absMatch[1].replace(/<[^>]+>/g, ""));
        }
        if (absTexts.length) {
          results.set(pmid, absTexts.join(" "));
        }
      }
    } catch (_) { /* skip failed batches */ }
  }
  return results;
}

async function tool_pubmed_for_genes(args) {
  const { gene_ids, include_abstract = false } = args || {};
  if (!gene_ids || !gene_ids.length) {
    throw Object.assign(new Error("gene_ids is required (non-empty array)"), { code: -32602 });
  }
  if (gene_ids.length > 500) {
    throw Object.assign(new Error("gene_ids limited to 500"), { code: -32602 });
  }

  // Step 1: Fetch PUBMED__xrefs from Solr, filtering to genes with capabilities:pubs
  // Use defType=lucene for reliable OR queries across multiple gene IDs
  const idList = gene_ids.join(" OR ");
  const solrResult = await solrFetch(SOLR_GENES_CORE, "query", {
    q: `id:(${idList})`,
    fq: ["capabilities:pubs"],
    fl: "id,name,description,PUBMED__xrefs",
    rows: gene_ids.length,
    defType: "lucene",
  });
  const docs = solrResult?.response?.docs || [];

  // Step 2: Collect all PMIDs and DOIs across all genes
  const allPmids = new Set();
  const allDois = new Set();
  const geneRefs = {};  // geneId → { pmids: [], dois: [] }

  for (const doc of docs) {
    const refs = doc["PUBMED__xrefs"] || [];
    const pmids = [];
    const dois = [];
    for (const ref of refs) {
      if (ref.startsWith("DOI:")) {
        dois.push(ref.slice(4));
        allDois.add(ref.slice(4));
      } else if (/^\d+$/.test(ref)) {
        pmids.push(ref);
        allPmids.add(ref);
      }
    }
    geneRefs[doc.id] = { name: doc.name, description: doc.description, pmids, dois };
  }

  // Step 3: Resolve DOI-only refs to PMIDs
  const doiToPmid = await resolveDoisToPmids([...allDois].filter(doi => {
    // only resolve DOIs that don't already have a PMID from the same gene
    return true;  // resolve all; we'll merge later
  }));
  for (const [doi, pmid] of doiToPmid) {
    allPmids.add(pmid);
  }

  // Step 4: Fetch paper metadata from NCBI
  const summaries = await fetchPubmedSummaries([...allPmids]);

  // Step 5: Optionally fetch abstracts
  let abstracts = new Map();
  if (include_abstract) {
    abstracts = await fetchPubmedAbstracts([...allPmids]);
  }

  // Step 6: Build per-gene results
  const genes = {};
  let totalPapers = 0;
  const allPaperIds = new Set();

  for (const geneId of gene_ids) {
    const ref = geneRefs[geneId];
    if (!ref) {
      genes[geneId] = { name: null, description: null, papers: [], count: 0 };
      continue;
    }

    const papers = [];
    const seenPmids = new Set();

    // Add papers from direct PMIDs
    for (const pmid of ref.pmids) {
      if (seenPmids.has(pmid)) continue;
      seenPmids.add(pmid);
      const summary = summaries.get(pmid);
      if (summary) {
        const paper = { ...summary };
        if (include_abstract && abstracts.has(pmid)) {
          paper.abstract = abstracts.get(pmid);
        }
        papers.push(paper);
        allPaperIds.add(pmid);
      }
    }

    // Add papers from DOIs (resolved to PMIDs)
    for (const doi of ref.dois) {
      const pmid = doiToPmid.get(doi);
      if (pmid && !seenPmids.has(pmid)) {
        seenPmids.add(pmid);
        const summary = summaries.get(pmid);
        if (summary) {
          const paper = { ...summary };
          if (include_abstract && abstracts.has(pmid)) {
            paper.abstract = abstracts.get(pmid);
          }
          papers.push(paper);
          allPaperIds.add(pmid);
        }
      } else if (!pmid) {
        // DOI couldn't be resolved — include as DOI-only reference
        papers.push({ doi, url: `https://doi.org/${doi}`, title: null, unresolved: true });
        allPaperIds.add(`doi:${doi}`);
      }
    }

    genes[geneId] = { name: ref.name || null, description: ref.description || null, papers, count: papers.length };
    totalPapers += papers.length;
  }

  return {
    gene_count: Object.keys(geneRefs).length,
    genes_with_papers: Object.values(genes).filter(g => g.count > 0).length,
    total_unique_papers: allPaperIds.size,
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

  enrichment_analysis: {
    definition: {
      name: "enrichment_analysis",
      description: [
        `Gene set enrichment analysis using hypergeometric test on ontology/pathway`,
        `annotation fields.`,
        ``,
        `Compares the frequency of annotation terms between a foreground gene set`,
        `(e.g. genes in a QTL interval, pathway, or user-defined list) and a background`,
        `set (typically all annotated genes in the same genome). Identifies terms that`,
        `are statistically overrepresented in the foreground.`,
        ``,
        `Both foreground and background are defined by Solr filter queries (fq arrays).`,
        `The tool automatically:`,
        `  1. Facet-counts the annotation field in both sets`,
        `  2. Computes hypergeometric p-values for each term`,
        `  3. Applies Benjamini–Hochberg FDR correction (or Bonferroni)`,
        `  4. Looks up term names from MongoDB`,
        `  5. Returns significant terms sorted by adjusted p-value`,
        ``,
        `Supported annotation fields:`,
        `  - GO__ancestors     — Gene Ontology (biological process, molecular function, cellular component)`,
        `  - PO__ancestors     — Plant Ontology (anatomy/development)`,
        `  - TO__ancestors     — Trait Ontology`,
        `  - domains__ancestors — Protein domains (InterPro)`,
        `  - pathways__ancestors — Plant Reactome pathways`,
        ``,
        `Example — GO enrichment for jasmonic acid pathway genes in sorghum:`,
        `  foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"]`,
        `  background_fq: ["taxonomy__ancestors:4558"]`,
        `  field: "GO__ancestors"`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          foreground_fq: {
            type: "array",
            items: { type: "string" },
            description: "Solr fq clauses defining the foreground gene set. E.g. ['pathways__ancestors:1119332', 'taxonomy__ancestors:4558'].",
          },
          background_fq: {
            type: "array",
            items: { type: "string" },
            description: "Solr fq clauses defining the background gene set. Typically just the genome filter, e.g. ['taxonomy__ancestors:4558']. Should be a superset of the foreground.",
          },
          field: {
            type: "string",
            enum: ["GO__ancestors", "PO__ancestors", "TO__ancestors", "domains__ancestors", "pathways__ancestors"],
            description: "Annotation field to test for enrichment. Default: GO__ancestors.",
          },
          p_threshold: {
            type: "number",
            description: "Adjusted p-value threshold. Terms with p_adjusted > this are excluded. Default: 0.05.",
          },
          correction: {
            type: "string",
            enum: ["bh", "bonferroni"],
            description: "Multiple testing correction: 'bh' = Benjamini–Hochberg FDR (default, recommended), 'bonferroni' = stricter family-wise error rate.",
          },
          min_foreground_count: {
            type: "integer",
            description: "Minimum number of foreground genes annotated with a term to include it. Default: 2.",
          },
          max_terms: {
            type: "integer",
            description: "Maximum enriched terms to return (sorted by p_adjusted). Default: 200.",
          },
          include_ancestors: {
            type: "boolean",
            description: [
              "When true, fetches all ancestor terms of the enriched terms from MongoDB",
              "and returns a 'dag' object containing the ontology subgraph connecting the",
              "enriched terms to their root(s). Each DAG node has: id, name, namespace,",
              "is_a (parent IDs), children (child IDs), and enrichment stats if significant.",
              "Use this to build an interactive ontology browser showing the enriched terms",
              "in their full hierarchical context. Default: false.",
            ].join(" "),
          },
        },
        required: ["foreground_fq", "background_fq"],
      },
    },
    handler: tool_enrichment_analysis,
  },

  pubmed_for_genes: {
    definition: {
      name: "pubmed_for_genes",
      description: [
        "Retrieve published literature (PubMed papers) associated with a list of genes.",
        "Fetches PUBMED__xrefs from the Solr genes index and resolves them to full paper",
        "metadata (title, authors, journal, date, DOI) via NCBI E-utilities.",
        "Optionally includes paper abstracts. Handles both PMID and DOI-only references.",
        "Use this to find what is known about candidate genes from the literature.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: {
            type: "array",
            items: { type: "string" },
            description: "Gene stable IDs to look up papers for (max 500). Include orthologs from other species to find literature on well-studied homologs.",
          },
          include_abstract: {
            type: "boolean",
            description: "When true, fetches paper abstracts from PubMed XML. Slower but provides full context for each paper. Default: false.",
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

## Query Routing

| User question shape | Start with | Load workflow |
|---------------------|------------|---------------|
| Gene name / function lookup | \`solr_suggest\` (term=) | \`gene_lookup\` |
| "Genes in pathway X for species Y" | \`solr_suggest\` (q= for pathway and species) | \`pathway_genes\` |
| QTL interval / trait candidate analysis | \`genes_in_region\` | \`qtl_candidate_ranking\` |
| "What's known about gene X?" | \`solr_search\` for metadata | \`literature_search\` |
| Cross-species comparison for a gene | \`solr_search\` for \`gene_tree\` | \`cross_species_comparison\`, \`orthologs_paralogs\` |
| Gene family across species | \`solr_suggest\` (term=family name) | \`gene_family\` |
| Germplasm / LOF alleles | \`vep_for_gene\` | \`germplasm_lof\` |
| Enrichment / overrepresentation | \`enrichment_analysis\` | \`enrichment\` |
| Presence/Absence or CNV | \`solr_search\` with facets | \`pav_cnv\` |
| Ambiguous or exploratory | \`kb_relations\` first | — |

## Critical Conventions

**Taxon ID formats — two encodings exist:**
- \`taxonomy__ancestors\` uses **plain NCBI taxon IDs** (e.g. \`4558\` sorghum,
  \`3702\` Arabidopsis, \`39947\` rice). Matches all subspecies/assemblies.
- \`taxon_id\` (the Solr field and \`genes_in_region\` parameter) uses
  **NCBI ID × 1000 + assembly suffix** (e.g. \`4558001\` for sorghum BTx623).
- **When in doubt, filter with \`taxonomy__ancestors\` using the plain NCBI ID.**

**Gene ID format — never abbreviate.** Always write the full stable identifier
(e.g. \`SORBI_3006G095600\`, never \`G095600\`). This applies everywhere.

**Display name rule.** Show genes as
\`GENE_ID / CLOSEST_NAME (description)\` — e.g.
\`SORBI_3006G147000 / RPL14B (60S ribosomal protein L14-2)\`. Fallback chain
when \`name\` equals the stable ID: \`closest_rep_name\` → \`model_rep_name\`
→ \`description\` → stable ID alone. Never show a bare gene ID without at
least one of these.

**\`solr_graph\` \`maxDepth\`.** Always pass \`maxDepth=1\`. Without it the
graph traversal recurses deeply and the query can run for minutes.

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
        { name: "taxon_id", description: "Solr taxon_id for the species (NCBI ID × 1000 + suffix, e.g. 4558001 for sorghum BTx623).", required: true },
      ],
    },
    template: `# Workflow: QTL candidate gene ranking

**Trait TO term:** {{trait_to_term}}
**Region:** {{region}}
**Start:** {{start}}
**End:** {{end}}
**Taxon ID (Solr format):** {{taxon_id}}

## Step 1 — Find the QTL interval
If a trait TO term was supplied:
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

## Step 3 — Score by ontology
\`\`\`
mongo_lookup_by_ids(
  collection: "TO",
  ids: <TO__ancestors integers from step-2 genes>
)
  → identify genes annotated to the trait or its ancestors
\`\`\`

## Step 4 — Find conserved orthologs
\`\`\`
solr_graph(
  from: "compara_neighbors_10",
  to:   "compara_idx_multi",
  seed_q: "gene_tree:<id>",
  fl: "id,system_name,gene_tree,name,closest_rep_name",
  maxDepth: 1
)
  → collect ortholog gene IDs across species
\`\`\`

## Step 5 — Score by expression
\`\`\`
expression_for_genes(
  gene_ids: <regional + orthologs>,
  experiment_type: "Baseline",
  taxon_id: {{taxon_id}},
  po_terms: [<trait-relevant tissue PO IDs>]
)
expression_for_genes(
  gene_ids: <same list>,
  experiment_type: "Differential"
)
  → flag significant DE (p_adjusted < 0.05) in relevant conditions
\`\`\`

## Step 6 — Literature evidence
\`\`\`
pubmed_for_genes(
  gene_ids: <regional + orthologs>,
  include_abstract: true
)
  → flag genes with published functional characterization
\`\`\`

## Step 7 — Synthesize ranking

Score each gene on:
- TO/GO annotation relevance (0–3 pts)
- Expressed in trait-relevant tissue (0–2 pts)
- Significant DE under trait-relevant condition (0–2 pts)
- Conserved expression across orthologous species (0–2 pts)
- Published functional characterization (0–3 pts: 3=direct study, 2=ortholog studied, 1=mentioned)
- LOF germplasm available (bonus flag — \`vep_for_gene\`)

Output: ranked table with explicit subtotals so the user can audit the
ranking. Report filter counts at every step (e.g. "120 genes in the interval
→ 34 with TO annotation to yield trait → 12 also DE in grain").`,
  },

  literature_search: {
    definition: {
      name: "literature_search",
      title: "Literature search for a gene (with ortholog fallback)",
      description:
        "Fetch PubMed papers for a gene; if the gene has no direct publications, " +
        "expand to rice and Arabidopsis orthologs.",
      arguments: [
        { name: "gene_id", description: "Gene stable ID (e.g. 'SORBI_3006G095600').", required: true },
      ],
    },
    template: `# Workflow: Literature search for a candidate gene

**Gene:** {{gene_id}}

Crop genes often have limited direct publications. Always include orthologs
from model species (rice, Arabidopsis) before concluding "no literature."

## Step 1 — Resolve the gene and its orthologs
\`\`\`
solr_search(
  q: "id:{{gene_id}}",
  fl: "id,name,gene_tree,homology__ortholog_one2one,closest_rep_id,model_rep_id"
)
\`\`\`
Extract ortholog IDs, especially from rice (Os…) and Arabidopsis (AT…).

## Step 2 — Fetch papers for the gene + orthologs
\`\`\`
pubmed_for_genes(
  gene_ids: ["{{gene_id}}", <ortholog_ids...>],
  include_abstract: true
)
\`\`\`

Response shape (per paper): \`pmid\`, \`title\`, \`authors[]\`, \`journal\`,
\`pubdate\`, \`doi\`, \`url\`, optional \`abstract\`, optional
\`unresolved: true\` for DOI-only refs.

## Fallbacks
- Absence of papers for \`{{gene_id}}\` does **not** mean the gene is
  unstudied — it means there is no cross-reference from Gramene's index to
  PubMed. Always consult orthologs in rice and Arabidopsis before concluding.
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

## Step 1 — Get the gene tree and 1:1 orthologs
\`\`\`
solr_search(
  q: "id:{{gene_id}}",
  fl: "id,gene_tree,homology__ortholog_one2one,compara_idx_multi"
)
\`\`\`
\`homology__ortholog_one2one\` = direct 1:1 orthologs across species (highest
confidence).

## Step 2 — Retrieve the full ortholog set (optional, includes all types)
\`\`\`
solr_graph(
  from: "compara_neighbors_10",
  to:   "compara_idx_multi",
  seed_q: "gene_tree:<tree_id>",
  fl: "id,name,system_name,closest_rep_name",
  maxDepth: 1
)
\`\`\`

## Step 3 — Compare expression across species
\`\`\`
expression_for_genes(
  gene_ids: <ortholog IDs>,
  experiment_type: "Baseline"
)
\`\`\`

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
- Use \`homology__ortholog_one2one\` when you need high-confidence functional
  equivalents for cross-species inference.
- Use \`gene_tree:<id>\` when you want the full family including all paralogs.

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

  enrichment: {
    definition: {
      name: "enrichment",
      title: "Gene set enrichment analysis (GO / PO / pathway / domain)",
      description:
        "Statistical enrichment of ontology terms, pathways, or domains for a foreground " +
        "gene set vs. a genome-wide background, with optional DAG rendering of the " +
        "enriched subgraph.",
      arguments: [
        { name: "foreground_fq", description: "Solr fq clauses defining the foreground set, as a JSON array of strings.", required: true },
        { name: "background_fq", description: "Solr fq clauses for the background (same genome).", required: true },
        { name: "field", description: "Annotation field: GO__ancestors (default), PO__ancestors, TO__ancestors, domains__ancestors, or pathways__ancestors.", required: false },
        { name: "include_ancestors", description: "Set true to return the DAG of enriched terms with their ontology ancestors.", required: false },
      ],
    },
    template: `# Workflow: Gene set enrichment analysis

**Foreground fq:** {{foreground_fq}}
**Background fq:** {{background_fq}}
**Field:** {{field}}
**include_ancestors:** {{include_ancestors}}

## Call
\`\`\`
enrichment_analysis(
  foreground_fq: {{foreground_fq}},
  background_fq: {{background_fq}},
  field: "{{field}}",
  p_threshold: 0.05,
  correction: "bh",
  min_foreground_count: 2,
  include_ancestors: {{include_ancestors}}
)
\`\`\`

The tool: (1) facet-counts the chosen annotation field in foreground and
background, (2) computes hypergeometric p-values per term, (3) applies BH
(default) or Bonferroni correction, (4) resolves term IDs to names from
MongoDB, and (5) returns enriched terms sorted by adjusted p-value.

## Output per significant term
- \`term_id\`, \`term_name\` — ontology ID and resolved name
- \`foreground_count\` / \`foreground_fraction\`
- \`background_count\` / \`background_fraction\`
- \`fold_enrichment\` = foreground fraction / background fraction
- \`p\` / \`p_adjusted\`

## Interpretation
- \`fold_enrichment > 2\` with \`p_adjusted < 0.05\` → strong signal.
- Check both \`foreground_count\` and \`background_count\` — a high fold
  enrichment driven by a single gene is rarely biologically meaningful.
- Run on multiple annotation fields (GO, pathways, domains) for a complete picture.
- The background should be all annotated genes in the **same genome** to avoid
  species composition bias.

## With \`include_ancestors=true\`
The response includes a \`dag\` object with \`node_count\`, \`root_ids\`, and
\`nodes\` (keyed by integer ID). Each node has \`id\`, \`name\`, \`namespace\`,
\`is_a\` (parent IDs), \`children\` (within the enriched subgraph), and — for
enriched nodes — \`enriched: true\`, \`fold_enrichment\`, \`p_adjusted\`,
\`foreground_count\`, \`background_count\`. Walk \`children\` recursively from
\`root_ids\` to render a collapsible DAG with enriched leaves highlighted in
their hierarchical context.

## When to use enrichment vs. facet counting
- \`enrichment_analysis\` — when you need statistical significance comparing
  foreground vs. background.
- \`solr_search\` with \`facet.field\` — when you just want to count terms
  (no hypothesis test).`,
  },

  pav_cnv: {
    definition: {
      name: "pav_cnv",
      title: "Presence/absence variation (PAV) and copy-number variation (CNV)",
      description:
        "Detect gene presence/absence and copy-number variation across an assembly panel, " +
        "either by simple faceting or via a single graph-traversal pivot query.",
      arguments: [
        { name: "gene_id", description: "Query gene stable ID (or rice ortholog ID) for seeding.", required: true },
        { name: "taxon_id", description: "Plain NCBI taxon ID of the target species (e.g. 4558).", required: true },
      ],
    },
    template: `# Workflow: PAV and CNV

**Query gene:** {{gene_id}}
**Species (NCBI taxon):** {{taxon_id}}

Two approaches — start with 5a for simple PAV/CNV questions, use 5b when you
need neighborhood context or want to minimize round-trips.

**Important caveat:** not all genomes were included in the Compara gene tree
analysis. Always check the \`maps\` MongoDB collection (\`in_compara: true\`)
to get the list of genomes that should have homology data — use that as the
denominator when interpreting absence.

## 5a — Basic faceting

\`\`\`
# Step 1 — get the gene tree
solr_search(q: "id:{{gene_id}}",
            fl: "id,gene_tree,homology__ortholog_one2one")
  → extract gene_tree id

# Step 2 — find which genomes participated in Compara
mongo_find(collection: "maps", filter: { in_compara: true },
           projection: { _id: 1, name: 1 })

# Step 3 — facet over all orthologs
solr_search(q: "gene_tree:<tree_id>", rows: 0,
            facet: { field: "system_name", mincount: 0, limit: -1 })

# Step 4 — interpret
# count=0       → gene absent in that genome (PAV)
# count=1       → single copy (expected)
# count>1       → duplication / CNV
# in_compara=true but not in facet results → absent (PAV)
\`\`\`

## 5b — Neighborhood CNV via graph + pivot (single round-trip)

\`\`\`
# Step 1 — get the gene tree
solr_search(q: "id:{{gene_id}}",
            fl: "id,gene_tree,system_name,homology__ortholog_one2one")

# Step 2 — one query for neighborhood CNV
solr_search(
  q: "{!graph from=compara_neighbors_10 to=compara_idx_multi maxDepth=1}gene_tree:<tree_id>",
  fq: ["taxonomy__ancestors:{{taxon_id}}"],
  rows: 0,
  facet: { pivot: "gene_tree,system_name", pivot_mincount: 1 }
)
\`\`\`

Response: \`facet_counts.facet_pivot["gene_tree,system_name"]\` — array of
\`{ value: <tree_id>, count: N, pivot: [{ value: <assembly>, count: k }, ...] }\`.

## Interpretation
- \`count=1\` across all \`in_compara\` genomes → single-copy conserved gene.
- Genome absent from pivot AND \`in_compara=true\` → PAV (gene absent).
- \`count>1\` in any genome → tandem duplication / CNV.

Cross-reference \`mongo_find(collection:"maps", filter:{in_compara:true})\` to
get the full denominator. To seed from a rice ortholog instead (cross-species
neighborhood), look up the rice gene's tree ID first, then use that as seed.`,
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
      protocolVersion: "2025-11-25",
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
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
