import fs from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Gramene MCP Server — bridges Claude to the public Gramene REST API
 * (https://data.gramene.org).
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
 *   GRAMENE_SITES        Sites to serve, as comma-separated id=apiBase pairs, e.g.
 *                          v69=https://data.gramene.org/v69,sorghum_v11=https://data.sorghumbase.org/sorghum_v11
 *                        or as a JSON array that can also describe each site:
 *                          [{"id":"v69","apiBase":"https://data.gramene.org/v69","description":"..."}]
 *                        Each site is served at /mcp/<id>; the first entry also
 *                        answers the bare /mcp path. Takes precedence over
 *                        GRAMENE_API_BASE.
 *   GRAMENE_API_BASE     Single-site shorthand: Gramene REST API base URL
 *                          (default: https://data.gramene.org/v69)
 *                        The site id is the URL's last path segment (e.g. v69).
 */

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || "8787");
const MAX_BODY_BYTES = Number(process.env.MCP_MAX_BODY_BYTES || "1048576");

// --- Sites ---
// A site pairs a URL-safe id with a Gramene REST API base. MCP traffic for a
// site arrives at /mcp/<id>, and every tool call made there queries that
// site's API and fills that site's reference-doc cache.
const RESERVED_SITE_IDS = new Set(["usage"]);

function parseSites() {
  const spec = (process.env.GRAMENE_SITES || "").trim();
  let entries;
  if (/^[[{]/.test(spec)) {
    entries = JSON.parse(spec);
  } else if (spec) {
    entries = spec.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`GRAMENE_SITES: expected id=url, got "${pair}"`);
      return { id: pair.slice(0, eq).trim(), apiBase: pair.slice(eq + 1).trim() };
    });
  } else {
    const apiBase = process.env.GRAMENE_API_BASE || "https://data.gramene.org/v69";
    entries = [{ id: new URL(apiBase).pathname.split("/").filter(Boolean).pop() || "default", apiBase }];
  }
  if (!Array.isArray(entries)) throw new Error("GRAMENE_SITES JSON must be an array");

  const sites = new Map();
  for (const { id, apiBase, description } of entries) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(id) || RESERVED_SITE_IDS.has(id)) {
      throw new Error(`Invalid site id "${id}"`);
    }
    if (sites.has(id)) throw new Error(`Duplicate site id "${id}"`);
    sites.set(id, {
      id,
      apiBase: new URL(apiBase).toString().replace(/\/$/, ""),
      description: description || null,
      refCache: {
        experiments: new Map(),
        assays:      new Map(),
        PO:          new Map(),
        germplasm:   new Map(),
      },
    });
  }
  if (sites.size === 0) throw new Error("GRAMENE_SITES defines no sites");
  return sites;
}

const SITES = parseSites();
const DEFAULT_SITE = SITES.values().next().value;

// Sent as `instructions` in the initialize reply. Every site exposes the same
// tool names, so this is how a client connected to several sites tells them apart.
function siteInstructions(site) {
  return [
    `This server serves the Gramene site "${site.id}", backed by the REST API at ${site.apiBase}.`,
    site.description,
    `All tools and prompts on this server read only this site's data. Other Gramene MCP servers ` +
      `offer the same tool names for other releases or species collections: use the one whose site ` +
      `matches the user's question, and say which site results came from when several are connected.`,
    `To list this site's genome assemblies, call mongo_find with collection "maps".`,
  ].filter(Boolean).join("\n\n");
}

// Single source of truth for server identity. Used by both the MCP `initialize`
// reply (over JSON-RPC) and the GET /mcp discovery endpoint (for clients that
// want to inspect transport, protocol versions, and capabilities without an
// initialize round-trip — modeled on https://pubmed.caseyjhand.com/mcp).
const SERVER_NAME = "gramene-mcp";
const SERVER_VERSION = "0.5.0";
const SERVER_DESCRIPTION =
  "MCP server bridging AI agents to the Gramene plant genomics database " +
  "via the public REST API at data.gramene.org. Tools cover gene search, " +
  "comparative genomics, expression, ontology / QTL annotations, predicted " +
  "loss-of-function germplasm, and literature cross-references.";
const SERVER_HOMEPAGE = "https://github.com/warelab/gramene-mcp";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const SESSION_HEADER = "Mcp-Session-Id";
const SERVER_CAPABILITIES = {
  tools:     { listChanged: false },
  prompts:   { listChanged: false },
  resources: false,
  logging:   false,
};

function getServerDiscoveryDoc(site) {
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
    site: { id: site.id, apiBase: site.apiBase, description: site.description },
    sites: [...SITES.values()].map((s) => ({
      id: s.id, apiBase: s.apiBase, description: s.description, mcp: `/mcp/${s.id}`,
    })),
    endpoints: {
      mcp:       `/mcp/${site.id}`,
      dashboard: `/mcp/${site.id}/usage`,
      stats:     `/mcp/${site.id}/usage/data`,
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
// Mcp-Session-Id response header. Clients echo it back on subsequent requests.
// Sessions older than SESSION_TTL_MS are pruned on each new initialize.
// A session belongs to the site it was initialized on.
const SESSION_TTL_MS = 24 * 3600_000; // 24 hours
const activeSessions = new Map(); // id -> { site, created, lastSeen }

function getOrCreateSession(sessionId, site) {
  if (sessionId && activeSessions.get(sessionId)?.site === site.id) return sessionId;
  return null;
}

function pruneOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of activeSessions) {
    if (new Date(s.lastSeen).getTime() < cutoff) activeSessions.delete(id);
  }
}

// --- Per-process memo for reference collections ---
//
// expression_for_genes joins gene expression fields with experiment / assay /
// PO metadata. To keep this fast without holding an in-memory copy of those
// collections, we memoize per-id docs the first time they're fetched from the
// API. Reference data is slow-changing, so a process-lifetime cache is fine —
// restart the server to refresh. Each site keeps its own cache (site.refCache)
// since ids can resolve to different docs across releases.
async function fetchRefDocs(site, collection, ids) {
  const cache = site.refCache[collection];
  if (!cache) throw new Error(`refCache: unknown collection ${collection}`);
  const missing = [];
  for (const id of ids) if (!cache.has(id)) missing.push(id);
  if (missing.length > 0) {
    // The API caps results at 'rows' (default 20). Chunk requests to be safe.
    const CHUNK = 200;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      // Pass idList as an array so each element is appended as its own
      // ?idList=… param — the API rejects single bare integer values.
      const docs = await apiGet(site, `/${collection}`, {
        idList: chunk.map(String),
        rows: chunk.length,
      });
      for (const doc of (Array.isArray(docs) ? docs : [])) {
        cache.set(doc._id, doc);
      }
      // Negative-cache misses so we don't refetch every call.
      for (const id of chunk) if (!cache.has(id)) cache.set(id, null);
    }
  }
  const out = new Map();
  for (const id of ids) {
    const doc = cache.get(id);
    if (doc) out.set(id, doc);
  }
  return out;
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

// Origins that always pass the Origin check (in addition to localhost and any
// values configured via MCP_ALLOWED_ORIGINS). These are the well-known origins
// for hosted MCP clients that connect to public servers.
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
  "https://api.anthropic.com",
]);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                      // no Origin header → allow
  if (ALLOW_ALL_ORIGINS) return true;            // MCP_ALLOWED_ORIGINS=* → allow all
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return LOCALHOST_PATTERNS.some((p) => origin.startsWith(p));
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  // Echo back the request Origin if allowed; otherwise wildcard is fine for
  // read-only/no-auth flows but credentialed requests need an explicit echo.
  const allowOrigin = origin && originAllowed(req) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const KB_RELATIONS = {
  search_index: {
    genes: {
      endpoint: "/search",
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
      endpoint: "/suggest",
      queryPattern: "Server-side suggester: pass the free-text term as 'q' and the API applies its own field boosts and grouping.",
      fields: {
        name:      { type: "string",  description: "Gene or feature name" },
        ids:       { type: "string",  description: "Gene/feature identifiers" },
        synonym:   { type: "string",  description: "Synonyms and aliases" },
        text:      { type: "string",  description: "Full-text search field" },
        relevance: { type: "float",   description: "Boost score from the suggester" },
        fq_field:  { type: "string",  description: "Search-index field name to use as fq in /search" },
        fq_value:  { type: "string|int", description: "Value to filter on in /search" }
      }
    }
  },
  collections: {
    // Reachable via mongo_find / mongo_lookup_by_ids (which call the API's
    // /<collection> endpoints — see the public Gramene REST API for shapes).
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
      description: "Gene metadata. _id = gene stable ID. Has location {region, start, end, strand, map}, xrefs, biotype, taxon_id, system_name, gene_idx. Homology subdocument: homology.gene_tree = {id, representative: {closest: {id, description, percent_identity, taxon_id}, model: {...}}, root_taxon_id}. Homology.homologous_genes mirrors the homology__* search-index fields keyed by relationship type (ortholog_one2one, ortholog_one2many, ortholog_many2many, within_species_paralog, gene_split), each containing an array of {id, system_name, ...} objects." },
    genetrees: { key: "_id", type: "string",
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
      description: "Genome assembly metadata. _id = assembly map name (e.g. GCA_000003195.3), matching the 'map' field on gene documents. Key field: in_compara (boolean) — true if this genome was included in the Compara gene tree analysis and therefore has homology/PAV data. Use this to distinguish genomes with homology info from those without before interpreting PAV/CNV facet results." },
    germplasm: { key: "_id", type: "string",
      description: "Germplasm accession metadata. _id = germplasm ens_id (e.g. 'SGT_PI514460', 'ARS105') matching values in VEP__* search-index fields. Fields: pub_id (public accession name/ID), stock_center (genebank code: ARS, IRRI, ICRISAT, sorbmutdb, NCBI, etc.), germplasm_dbid (numeric ID for stock center hyperlink), subpop (subpopulation classification), pop_id (study ID matching VEP field name). Used by vep_for_gene to enrich germplasm IDs with links and metadata." },
  }
};

// The collection names served by the /<collection> endpoints.
const COLLECTIONS = [
  "genes", "genetrees", "maps", "domains", "taxonomy",
  "GO", "PO", "TO", "qtls", "pathways",
  "expression", "assays", "experiments", "germplasm",
  // Rich per-gene expression summary: the Mongo source behind the expr_*__attr_*
  // search fields (tau, max_tpm, breadth, per_organ, activated_by/repressed_by).
  // Use gene_search to FIND genes by those values; this to READ one gene's profile.
  "expression_attributes",
  // "homologs" (2.68M docs) is deliberately NOT listed yet: the /{collection}
  // catch-all that serves it is fixed in the deployed swagger tree but the service
  // has not been restarted, so requests still fail. Add it once that lands.
];

// --- Gramene REST API helpers ---
function apiUrl(site, path, params) {
  const url = new URL(`${site.apiBase}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (k === "idList") {
      // The API's swagger declares idList as type=array (CSV). When a single
      // numeric value is passed bare (?idList=3702) the validator coerces it
      // back to an integer and rejects the request. A trailing comma forces
      // it to parse as an array.
      const values = Array.isArray(v) ? v.map(String) : [String(v)];
      let csv = values.join(",");
      if (values.length === 1) csv += ",";
      url.searchParams.set(k, csv);
    } else if (Array.isArray(v)) {
      v.forEach((x) => url.searchParams.append(k, String(x)));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Requests to the Gramene API had no timeout at all: a slow Solr query (a wide facet
// over a 5.4M-doc core, say) would hang the tool call forever, and this process serves
// three sites, so one stuck call ties up a connection for everyone.
const API_TIMEOUT_MS = Number(process.env.GRAMENE_API_TIMEOUT_MS || "30000");

async function apiGet(site, path, params) {
  const url = apiUrl(site, path, params);
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  }).catch((e) => {
    if (e?.name === "TimeoutError" || /abort/i.test(e?.message || "")) {
      throw new Error(`Gramene API timed out after ${API_TIMEOUT_MS}ms on ${path} — narrow the query (fewer rows, smaller facet.limit)`);
    }
    throw e;
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Gramene API HTTP ${r.status} on ${path}: ${txt || r.statusText}`);
  }
  return r.json();
}

// /search wraps the Solr genes core; it accepts standard Solr query params
// (q, fq, fl, rows, start, sort, defType, facet.*, stats.*) and returns the
// raw Solr response.
async function searchFetch(site, args) {
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
    throw new Error("search requires a non-empty string 'q'");
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

  return apiGet(site, "/search", {
    q, fq, fl, rows, start, sort, defType, wt: "json",
    ...facetParams, ...statsParams,
  });
}

// /suggest wraps the Solr suggestions core. Only q / fq / rows / start are
// meaningful — the suggester applies its own field boosts and grouping. The
// response is a Solr "grouped" envelope (grouped.category.groups[].doclist).
async function suggestFetch(site, { q, fq, rows = 10, start = 0 } = {}) {
  if (!q || typeof q !== "string") {
    throw new Error("suggest requires a non-empty string 'q'");
  }
  return apiGet(site, "/suggest", { q, fq, rows, start });
}

// /<collection> endpoints translate query params into a MongoDB find on the
// named collection. Supported params: q (text), idList, rows, start, fl
// (returns only listed fields), taxon_id, db_type, subset, plus any other
// query param becomes a top-level equality filter on the document.
async function collectionFetch(site, collection, params) {
  if (!COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown collection: ${collection}. Allowed: ${COLLECTIONS.join(", ")}`);
  }
  return apiGet(site, `/${collection}`, params || {});
}

// --- Result-size policy -------------------------------------------------------
// Every tool result is pretty-printed into ONE text block that lands directly in the
// model's context. A 1000-doc Solr response is megabytes of JSON, which exhausts the
// context before the agent can read any of it. Cap centrally, in the dispatcher, so
// the pre-existing tools are covered too.
const RESULT_MAX_BYTES = Number(process.env.MCP_MAX_RESULT_BYTES || "200000");
const RESULT_SAMPLE_DOCS = 20;
const DEFAULT_GENE_FL =
  "id,name,description,system_name,taxon_id,region,start,end,strand,biotype";

function capRows(rows, { def = 50, max = 200, name = "rows" } = {}) {
  if (rows === undefined || rows === null) return def;
  if (!Number.isInteger(rows) || rows < 0) throw new Error(`${name} must be a non-negative integer`);
  return Math.min(rows, max);
}

function capArray(a, max, name) {
  if (!Array.isArray(a) || a.length === 0) throw new Error(`${name} must be a non-empty array`);
  if (a.length > max) throw new Error(`${name} accepts at most ${max} entries (got ${a.length})`);
  return a;
}

// Trim the biggest doc array and SAY SO, rather than truncating the JSON text (which
// would hand the model unparseable output) or silently dropping rows.
function capResultText(result) {
  let text = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(text) <= RESULT_MAX_BYTES) return text;
  const trimmed = structuredClone(result);
  const paths = [["response", "docs"], ["docs"], ["genes"], ["sequences"], ["items"], ["by_genome"]];
  // Trim repeatedly: one pass is not enough. With fl=* a single gene document can carry
  // thousands of rsIDs, so even 20 docs can exceed the budget on their own. Halve until
  // it fits or we are down to a single element.
  let keep = RESULT_SAMPLE_DOCS;
  for (let pass = 0; pass < 8; pass++) {
    let touched = false;
    for (const path of paths) {
      let node = trimmed;
      for (let i = 0; i < path.length - 1; i++) node = node?.[path[i]];
      const key = path[path.length - 1];
      const arr = node?.[key];
      if (Array.isArray(arr) && arr.length > keep) {
        const total = trimmed._truncated?.total ?? arr.length;
        node[key] = arr.slice(0, keep);
        trimmed._truncated = {
          reason: `result exceeded ${RESULT_MAX_BYTES} bytes`,
          path: path.join("."), kept: keep, total,
          advice: "narrow 'fl' (attribute fields like rsid__attr_ss hold thousands of values), lower 'rows', or ask for a summary (rows:0 with a facet).",
        };
        touched = true;
      }
    }
    text = JSON.stringify(trimmed, null, 2);
    if (Buffer.byteLength(text) <= RESULT_MAX_BYTES) return text;
    if (!touched && keep <= 1) break;
    keep = keep > 1 ? Math.floor(keep / 2) : 1;
    if (keep < 1) keep = 1;
  }
  // Still too big with a single element — the individual document is the problem. Say so
  // rather than handing back unparseable truncated JSON.
  if (Buffer.byteLength(text) > RESULT_MAX_BYTES) {
    return JSON.stringify({
      _truncated: {
        reason: `result exceeded ${RESULT_MAX_BYTES} bytes even at one element`,
        advice: "a single document is too large — request specific fields with 'fl' instead of '*'.",
      },
      ...(trimmed._truncated && { detail: trimmed._truncated }),
    }, null, 2);
  }
  return text;
}

function solrEscapeValue(v) {
  // Wraps value in quotes for use in fq clauses (field:"value").
  // Safe for spaces and special chars; fine for numeric IDs too.
  const s = String(v);
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// --- Filter-tree serialization -------------------------------------------------
// Verbatim port of gramene-search src/bundles/filters.js:
// selectGrameneFiltersQueryString (:641-695), EXPANSIONS (:91-116),
// escapeForQuery (:150-152), formatIntervalValue (:43-46).
// Keep the regexes and the BRANCH ORDER character-identical: if this drifts, the same
// saved view returns different genes in the web UI and here, silently.
const FT_HAS_SPACES    = /^[^\[\(].*\s/;
const FT_IS_QUERY      = /\([a-zA-Z0-9_]+:[a-zA-Z0-9_]+\s/;
const FT_IS_REGION     = /^\(map:/;
const FT_ID_WITH_COLON = /^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$/;

const FT_EXPANSIONS = {
  orthologs:    { from: "homology__all_orthologs",          to: "id" },
  paralogs:     { from: "homology__within_species_paralog", to: "id" },
  neighborhood: { from: "compara_neighbors_10",             to: "compara_idx_multi" },
};

// Backslash FIRST, then quote — the order matters, or the backslashes added for the
// colon-escaped values get un-escaped by Solr's inner parser and the query degenerates
// to the whole index (5,407,132 rows instead of 789,630, HTTP 200, no error).
function ftEscapeForQuery(sub) {
  return String(sub).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// QTL suggestion documents in sorghum_suggestions11 store a CONTAINMENT interval —
// "(map:M AND region:R AND start:[S TO E])" — with no end clause, so every gene that
// starts before the interval and reaches into it is missed. The client's
// formatIntervalValue already emits the correct OVERLAP form; these 13,461 stored docs
// predate it. Rewrite on the way past so callers get the right genes without waiting
// for a suggestions reindex.
const FT_INTERVAL_CONTAIN =
  /^\(map:(\S+) AND region:(\S+) AND start:\[(\d+) TO (\d+)\]\)$/;
function ftNormalizeInterval(v) {
  const m = FT_INTERVAL_CONTAIN.exec(String(v));
  if (!m) return String(v);
  return `(map:${m[1]} AND region:${m[2]} AND start:[* TO ${m[4]}] AND end:[${m[3]} TO *])`;
}

function ftOwnQuery(node, depth) {
  if (depth > 12) throw new Error("filter tree nested deeper than 12 levels");
  if (Object.prototype.hasOwnProperty.call(node, "children")) {
    // Only AND and OR are valid infix operators; anything else would be interpolated
    // raw and produce a Solr 400 that surfaces as blank results, not an error.
    const op = (node.operation === "AND" || node.operation === "OR") ? node.operation : "OR";
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length > 200) throw new Error("filter node has more than 200 children");
    // SORT before joining — keeps query strings canonical across clients.
    return `(${kids.map((c) => ftGetQuery(c, depth + 1)).sort().join(` ${op} `)})`;
  }
  if (!node.fq_field || node.fq_value === undefined || node.fq_value === null) {
    throw new Error("filter leaf requires 'fq_field' and 'fq_value'");
  }
  const raw = node.fq_field === "location" ? ftNormalizeInterval(node.fq_value) : String(node.fq_value);
  // Branch order is load-bearing and matches filters.js exactly.
  if (node.fq_field === "location" && FT_IS_REGION.test(raw)) return `${raw}`;
  if (FT_IS_QUERY.test(raw))       return `${raw.replace(/:/g, "\\:")}`;
  if (FT_HAS_SPACES.test(raw))     return `${node.fq_field}:"${raw}"`;
  if (FT_ID_WITH_COLON.test(raw))  return `${node.fq_field}:${raw.replace(/:/g, "\\:")}`;
  return `${node.fq_field}:${raw}`;
}

function ftGetQuery(node, depth = 0) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("each filter node must be an object");
  }
  const negate = node.negate ? "NOT " : "";
  const clause = ftOwnQuery(node, depth);
  const expType = (typeof node.expand === "string" && node.expand) ? node.expand : null;
  if (!expType) return `${negate}${clause}`;
  const spec = FT_EXPANSIONS[expType];
  // Unknown expansion (e.g. a link from a newer client): degrade to the un-expanded
  // clause rather than emitting something broken.
  if (!spec) return `${negate}${clause}`;
  // An expansion of nothing must match nothing; '*:*' here would turn an empty group
  // into "every gene in the index".
  if (!clause || clause === "()") return `${negate}(*:* AND NOT *:*)`;
  // The braces MUST stay inside the quoted _query_ value. A bare {!graph …} in q fails
  // SILENTLY — 0 rows in some shapes, millions in others, always HTTP 200.
  const graph = `{!graph from=${spec.from} to=${spec.to} maxDepth=1 returnRoot=true}`;
  return `${negate}(_query_:"${graph}${ftEscapeForQuery(clause)}")`;
}

function ftQueryString(root) {
  if (!root || typeof root !== "object") throw new Error("gene_search: 'filters' must be an object");
  if (root.rightIdx === 1) return "*:*";          // empty tree, per filters.js:693
  return `*:* AND (${ftGetQuery(root, 0)})`;
}

// gramene-bedify emits chromStart > chromEnd for minus-strand features (verified:
// "1 14899 14503 EER93047-1 0 -"), which bedtools and IGV reject. Normalize on the way
// out; the upstream bug is filed separately.
function normalizeBed(raw) {
  return String(raw)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const f = line.split("\t");
      if (f.length >= 3) {
        const a = Number(f[1]), b = Number(f[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && a > b) { f[1] = String(b); f[2] = String(a); }
      }
      return f.join("\t");
    })
    .join("\n");
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

// --- mongo_find filter translation ---
//
// The public API's /<collection> endpoints only support id-based lookup
// (`idList=…`) and top-level field-equality filters (each extra query param
// becomes an equality predicate; arrays become $in). Anything richer — $gt,
// $lt, $regex, $where, $and, $or, dotted paths — is not supported.
//
// translateFilterToParams() converts a *restricted* MongoDB-style filter into
// the API's query-param shape, and throws on anything the API can't express.

const REJECTED_FILTER_OPS = [
  "$where", "$accumulator", "$function",
  "$and", "$or", "$nor", "$not",
  "$gt", "$gte", "$lt", "$lte", "$ne", "$exists",
  "$regex", "$text", "$expr", "$type", "$mod", "$all", "$elemMatch", "$size",
];

function translateFilterToParams(filter) {
  if (filter === null || filter === undefined) return {};
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error("filter must be a plain object");
  }
  const params = {};
  for (const [key, value] of Object.entries(filter)) {
    if (REJECTED_FILTER_OPS.includes(key)) {
      throw new Error(`Operator '${key}' is not supported by the Gramene REST API`);
    }
    if (key.startsWith("$")) {
      throw new Error(`Operator '${key}' is not supported by the Gramene REST API`);
    }
    if (key.includes(".")) {
      throw new Error(`Dotted path '${key}' is not supported by the Gramene REST API`);
    }
    if (key === "_id") {
      params.idList = translateIdClause(value);
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Only {$in: [...]} is allowed inside a value.
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === "$in" && Array.isArray(value.$in)) {
        params[key] = value.$in.map(String);
        continue;
      }
      for (const k of keys) {
        if (REJECTED_FILTER_OPS.includes(k) || k.startsWith("$")) {
          throw new Error(`Operator '${k}' on field '${key}' is not supported by the Gramene REST API`);
        }
      }
      throw new Error(`Nested object filter on '${key}' is not supported by the Gramene REST API`);
    }
    params[key] = String(value);
  }
  return params;
}

function translateIdClause(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$in" && Array.isArray(value.$in)) {
      return value.$in.map(String);
    }
    throw new Error("_id supports only direct equality or {$in: [...]}");
  }
  return [String(value)];
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

async function tool_genes_in_region(args, site) {
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
  return searchFetch(site, { q, fq, fl, rows, sort });
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

async function tool_expression_for_genes(args, site) {
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

  // 1. Fetch gene docs from /search with the expression fields included.
  const flParts = ["id", "name", "description", "expressed_in_gxa_attr_ss"];
  if (wantBaseline)     flParts.push("*__expr");
  if (wantDifferential) flParts.push("*_l2fc_attr_f", "*_pval_attr_f");
  // The public API's default /search parser ignores Lucene operators in q,
  // so put the multi-id OR clause in fq (which is parsed as raw lucene).
  const idClause = `id:(${gene_ids.join(" OR ")})`;
  const solrResp = await searchFetch(site, {
    q: "*:*",
    fq: [idClause, "capabilities:expression"],
    fl: flParts.join(","),
    rows: gene_ids.length,
  });
  const docs = solrResp?.response?.docs || [];

  // 2. Collect referenced experiment + assay IDs from the gene docs so we can
  //    fetch their metadata from /experiments and /assays in batches.
  const expIds = new Set();
  const assayIds = new Set();
  const baselineRefs = []; // [{doc, field, value, experiment, group}]
  const diffRefsByDoc = new Map(); // doc → Map(key → {experiment, control_group, treatment_group, l2fc?, p_value?})

  for (const doc of docs) {
    if (wantBaseline) {
      for (const [field, value] of Object.entries(doc)) {
        if (!field.endsWith("__expr") || value == null) continue;
        const parsed = parseBaselineField(field);
        if (!parsed) continue;
        expIds.add(parsed.experiment);
        assayIds.add(`${parsed.experiment}.${parsed.group}`);
        baselineRefs.push({ doc, value, ...parsed });
      }
    }
    if (wantDifferential) {
      const contrasts = new Map();
      for (const [field, value] of Object.entries(doc)) {
        const parsed = parseDifferentialField(field);
        if (!parsed || value == null) continue;
        expIds.add(parsed.experiment);
        assayIds.add(`${parsed.experiment}.${parsed.control_group}`);
        assayIds.add(`${parsed.experiment}.${parsed.treatment_group}`);
        const key = `${parsed.experiment}__${parsed.control_group}__${parsed.treatment_group}`;
        const slot = contrasts.get(key) || {
          experiment:      parsed.experiment,
          control_group:   parsed.control_group,
          treatment_group: parsed.treatment_group,
        };
        slot[parsed.metric] = value;
        contrasts.set(key, slot);
      }
      if (contrasts.size > 0) diffRefsByDoc.set(doc, contrasts);
    }
  }

  // 3. Fetch experiment + assay docs via the API.
  const experimentDocs = expIds.size > 0
    ? await fetchRefDocs(site, "experiments", [...expIds])
    : new Map();
  const assayDocs = assayIds.size > 0
    ? await fetchRefDocs(site, "assays", [...assayIds])
    : new Map();

  // 4. Build the set of experiments allowed by the type / taxon filters.
  const allowedExperiments = new Set();
  for (const [id, exp] of experimentDocs) {
    if (experiment_type && exp.type !== experiment_type) continue;
    if (taxon_id !== undefined && Number(exp.taxon_id) !== Number(taxon_id)) continue;
    allowedExperiments.add(id);
  }

  // 5. PO term expansion. If callers passed PO ints, fetch the corresponding
  //    PO docs to discover ancestors, then treat the union as "matching".
  const poInfo = { requested: null, expanded: false, ancestors_used: [] };
  let allowedPoIds = null;
  let strictPoIds  = null;
  if (po_terms && po_terms.length > 0) {
    strictPoIds  = new Set(po_terms.map(Number));
    poInfo.requested = [...strictPoIds];
    allowedPoIds = new Set(strictPoIds);
    const poDocs = await fetchRefDocs(site, "PO", [...strictPoIds]);
    for (const id of strictPoIds) {
      const poDoc = poDocs.get(id);
      if (Array.isArray(poDoc?.ancestors)) {
        for (const a of poDoc.ancestors) if (!strictPoIds.has(a)) {
          allowedPoIds.add(a);
          poInfo.ancestors_used.push(a);
        }
      }
    }
  }

  // 6. Walk each gene doc, joining with the prefetched experiment + assay docs.
  const genes = {};
  let strictMatchedAny = false;

  // Group baseline refs by doc for per-gene processing.
  const baselineByDoc = new Map();
  for (const ref of baselineRefs) {
    if (!baselineByDoc.has(ref.doc)) baselineByDoc.set(ref.doc, []);
    baselineByDoc.get(ref.doc).push(ref);
  }

  for (const doc of docs) {
    const baseline = [];
    const differential = [];

    if (wantBaseline) {
      for (const ref of baselineByDoc.get(doc) || []) {
        if (!allowedExperiments.has(ref.experiment)) continue;
        const assay = assayDocs.get(`${ref.experiment}.${ref.group}`);
        const poIds = assayPoIds(assay);
        if (allowedPoIds) {
          let matched = false;
          for (const id of poIds) if (allowedPoIds.has(id)) { matched = true; break; }
          if (!matched) continue;
          if (!strictMatchedAny) {
            for (const id of poIds) if (strictPoIds.has(id)) { strictMatchedAny = true; break; }
          }
        }
        const exp = experimentDocs.get(ref.experiment);
        baseline.push({
          experiment:      ref.experiment,
          experiment_name: exp?.name ?? null,
          group:           ref.group,
          value:           ref.value,
          tissue:          assayTissue(assay),
          factors:         assay?.factor ?? [],
        });
      }
    }

    if (wantDifferential) {
      const contrasts = diffRefsByDoc.get(doc);
      if (contrasts) for (const slot of contrasts.values()) {
        if (!allowedExperiments.has(slot.experiment)) continue;
        const cAssay = assayDocs.get(`${slot.experiment}.${slot.control_group}`);
        const tAssay = assayDocs.get(`${slot.experiment}.${slot.treatment_group}`);
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
        const exp = experimentDocs.get(slot.experiment);
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

async function tool_vep_for_gene(args, site) {
  const { gene_ids, include_germplasm_details = true } = args || {};
  if (!Array.isArray(gene_ids) || gene_ids.length === 0) {
    throw new Error("vep_for_gene requires a non-empty 'gene_ids' array");
  }
  if (gene_ids.length > 50) {
    throw new Error("vep_for_gene: max 50 gene_ids per call");
  }

  // 1. Fetch VEP__ dynamic fields from /search
  // The API's default q-parser doesn't honor Lucene OR; put the id clause in fq.
  const idClause = `id:(${gene_ids.join(" OR ")})`;
  const solrResp = await searchFetch(site, {
    q: "*:*",
    fq: [idClause],
    fl: "id,VEP__*",
    rows: gene_ids.length,
  });

  const solrDocs = solrResp?.response?.docs ?? [];

  // 2. Collect all germplasm ens_ids referenced across genes.
  const allEnsIds = new Set();
  for (const doc of solrDocs) {
    for (const [field, values] of Object.entries(doc)) {
      if (field.startsWith("VEP__") && Array.isArray(values)) {
        values.forEach((v) => allEnsIds.add(v));
      }
    }
  }

  // 3. Look up germplasm metadata via the API.
  let germplasmMap = {};
  if (allEnsIds.size > 0 && include_germplasm_details) {
    const germDocs = await fetchRefDocs(site, "germplasm", [...allEnsIds]);
    for (const [id, g] of germDocs) germplasmMap[id] = g;
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

async function tool_pubmed_for_genes(args, site) {
  const { gene_ids } = args || {};
  if (!gene_ids || !gene_ids.length) {
    throw Object.assign(new Error("gene_ids is required (non-empty array)"), { code: -32602 });
  }
  if (gene_ids.length > 500) {
    throw Object.assign(new Error("gene_ids limited to 500"), { code: -32602 });
  }

  // Fetch PUBMED__xrefs from /search, restricted to genes flagged with publications.
  // The API's default q-parser doesn't honor Lucene OR; put the id clause in fq.
  const idClause = `id:(${gene_ids.join(" OR ")})`;
  const solrResult = await searchFetch(site, {
    q: "*:*",
    fq: [idClause, "capabilities:pubs"],
    fl: "id,name,description,PUBMED__xrefs",
    rows: gene_ids.length,
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

async function tool_solr_search(args, site) {
  return searchFetch(site, args);
}

// /suggest does NOT apply field boosts of its own — it pipes `q` straight to Solr's
// /query handler, which has no default field, so a bare term matches NOTHING.
// Verified: q=msd2 -> 0 groups; the boosted form below -> 5. The web client has always
// supplied the boosts itself (gramene-search/src/bundles/api.js:33); so must we.
const SUGGEST_SIMPLE = /^[A-Za-z0-9_.:+-]+$/;

function boostedSuggestQuery(term) {
  const t = String(term).trim();
  if (!t) throw new Error("solr_suggest: 'term' is empty");
  if (t.length > 200) throw new Error("solr_suggest: 'term' longer than 200 chars");
  if (!SUGGEST_SIMPLE.test(t)) {
    // Phrases and Lucene metacharacters: quote it and drop the prefix wildcards,
    // which are meaningless against a phrase.
    const p = `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return `{!boost b=relevance}name:${p}^5 synonym:${p}^3 text:${p}^1`;
  }
  return `{!boost b=relevance}name:${t}^5 ids:${t}^5 ids:${t}*^3 ` +
         `synonym:${t}^3 synonym:${t}*^2 text:${t}*^1`;
}

async function tool_solr_suggest(args, site) {
  const { term, q, fq, rows = 10, start = 0 } = args || {};
  if (!term && !q) throw new Error("solr_suggest requires 'term' or 'q'");
  // 'term' = free text, gets the boosts. 'q' = caller-built raw Solr query, verbatim.
  const query = term ? boostedSuggestQuery(term) : q;
  return suggestFetch(site, { q: query, fq, rows, start });
}

async function tool_solr_search_bool(args, site) {
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

  return searchFetch(site, {
    q, fq: fq.length ? fq : undefined, fl, rows, start, sort, defType,
  });
}

async function tool_solr_graph(args, site) {
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
  return searchFetch(site, { q, fq, fl, rows, start, sort });
}

async function tool_mongo_list_collections() {
  // The public API exposes a fixed enum of collections — return it as a list
  // of name-only entries (compatible with the historical mongo shape).
  return {
    count: COLLECTIONS.length,
    collections: COLLECTIONS.map((name) => ({ name })),
  };
}

async function tool_mongo_find(args, site) {
  const {
    collection,
    filter = {},
    projection,
    limit = 50,
    skip = 0,
  } = args || {};

  if (!collection || typeof collection !== "string") {
    throw new Error("mongo_find requires string 'collection'");
  }
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    throw new Error("'filter' must be an object");
  }

  // 'sort' was previously accepted; the public API doesn't expose sorting, so
  // we ignore it silently rather than fail (sort isn't critical for any current
  // workflow).
  const params = translateFilterToParams(filter);
  const fl = projectionToFl(projection);
  if (fl) params.fl = fl;
  params.rows = Math.min(Math.max(limit, 0), 1000);
  if (skip) params.start = skip;

  const docs = await collectionFetch(site, collection, params);
  const arr = Array.isArray(docs) ? docs : [];
  // Honor projection: { _id: 0 } → strip _id from each doc. The API's `fl`
  // already excludes _id when an fl list is set; this catches the case where
  // the caller only specified { _id: 0 } with no positive fields.
  if (projection && projection._id === 0) {
    for (const d of arr) delete d._id;
  }
  return { count: arr.length, docs: arr };
}

async function tool_mongo_lookup_by_ids(args, site) {
  const { collection, ids, projection } = args || {};
  if (!collection) throw new Error("collection required");
  if (!Array.isArray(ids)) throw new Error("ids must be an array");
  if (ids.length === 0) return { count: 0, docs: [] };

  const params = {
    idList: ids.map(String),
    rows: ids.length,
  };
  const fl = projectionToFl(projection);
  if (fl) params.fl = fl;

  const docs = await collectionFetch(site, collection, params);
  const arr = Array.isArray(docs) ? docs : [];
  if (projection && projection._id === 0) {
    for (const d of arr) delete d._id;
  }
  return { count: arr.length, docs: arr };
}

// Translate a MongoDB-style projection ({ field: 1, ... }) into the API's
// `fl` (comma-separated field list). Returns null for an empty / exclusion-only
// projection so the API can return all fields.
function projectionToFl(projection) {
  if (!projection || typeof projection !== "object") return null;
  const include = Object.entries(projection)
    .filter(([k, v]) => v === 1 || v === true)
    .map(([k]) => k);
  return include.length > 0 ? include.join(",") : null;
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

// --- SorghumBase v11 tools -----------------------------------------------------

// /saved_views and /gene_lists key on a site FAMILY ("sorghum"), not the release id
// ("sorghum_v11"). Override per site with userDataSite in GRAMENE_SITES if that ever
// stops holding.
function userDataSite(site) {
  return site.userDataSite || String(site.id).replace(/_v\d+[a-z]?$/, "");
}

const GENE_SEARCH_MAX_BED_IDS = 5000;

async function tool_gene_search(args, site) {
  const {
    filters, saved_view_hash, genomes, extra_fq, fl, sort,
    facets, facet_limit = 50, stats,
    output = "docs", bed_feature = "gene", bed_combiner = "canonical", start = 0,
  } = args || {};
  const rows = capRows(args?.rows, { def: 50, max: 200 });

  let tree = filters;
  let savedView = null;
  if (saved_view_hash) {
    if (filters) throw new Error("gene_search: pass either 'filters' or 'saved_view_hash', not both");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(saved_view_hash)) throw new Error("gene_search: bad saved_view_hash");
    const got = await apiGet(site, "/saved_views", { hash: saved_view_hash });
    const doc = Array.isArray(got) ? got[0] : got;
    tree = doc?.state?.filters;
    if (!tree) throw new Error(`gene_search: saved view ${saved_view_hash} has no state.filters (private views need a Bearer token)`);
    savedView = { hash: saved_view_hash, label: doc.label ?? null, site: doc.site ?? null };
  }
  if (!tree) throw new Error("gene_search requires 'filters' or 'saved_view_hash'");

  const q = ftQueryString(tree);
  const fq = [];
  // The genome subset belongs in fq, never in q. These are SYNTHETIC per-assembly
  // taxon ids (4558006 …), not NCBI ids — get them from /maps.
  if (genomes !== undefined) {
    const g = capArray(genomes, 300, "genomes");
    for (const t of g) if (!Number.isInteger(t)) throw new Error("genomes must be integers");
    fq.push(`taxon_id:(${g.join(" OR ")})`);
  }
  if (extra_fq !== undefined) {
    if (!Array.isArray(extra_fq) || extra_fq.length > 10) throw new Error("extra_fq must be an array of at most 10 strings");
    for (const c of extra_fq) if (typeof c !== "string") throw new Error("extra_fq entries must be strings");
    fq.push(...extra_fq);
  }

  if (output === "count") {
    const res = await searchFetch(site, { q, fq, rows: 0 });
    return { query: q, fq, ...(savedView && { saved_view: savedView }), numFound: res.response?.numFound ?? 0 };
  }

  if (output === "bed") {
    // wt=bed on /search is broken (it routes to /export, which needs docValues on id).
    // Resolve ids first, then use the Mongo-backed /genes path, which works.
    if (!["gene", "transcript", "exon", "intron", "CDS", "utr5", "utr3"].includes(bed_feature)) {
      throw new Error(`gene_search: bad bed_feature '${bed_feature}'`);
    }
    if (!["canonical", "all"].includes(bed_combiner)) throw new Error("gene_search: bed_combiner must be 'canonical' or 'all'");
    const hits = await searchFetch(site, { q, fq, fl: "id", rows: GENE_SEARCH_MAX_BED_IDS, sort: "gene_idx asc" });
    const total = hits.response?.numFound ?? 0;
    const ids = (hits.response?.docs || []).map((d) => d.id);
    if (total > ids.length) {
      throw new Error(`gene_search: ${total} genes exceeds the ${GENE_SEARCH_MAX_BED_IDS}-gene BED cap — narrow the filter`);
    }
    if (!ids.length) return { query: q, fq, n_genes: 0, bed: "" };
    const url = apiUrl(site, "/genes", { idList: ids, wt: "bed", bedFeature: bed_feature, bedCombiner: bed_combiner, rows: ids.length });
    const r = await fetch(url, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`gene_search bed: HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    return {
      query: q, fq, n_genes: ids.length, bed_feature, bed_combiner,
      bed: normalizeBed(await r.text()),
      note: "chromStart/chromEnd normalized here; the upstream BED writer emits start>end on minus-strand features.",
    };
  }

  const res = await searchFetch(site, {
    q, fq, start,
    rows: output === "facets" ? 0 : rows,
    fl: output === "facets" ? undefined : (fl || DEFAULT_GENE_FL),
    sort,
    ...(facets && { facet: { field: capArray(facets, 5, "facets"), limit: facet_limit, mincount: 1 } }),
    ...(stats && { stats: { field: capArray(stats, 5, "stats") } }),
  });
  return { query: q, fq, ...(savedView && { saved_view: savedView }), ...res };
}

// PTV ⊆ PAV ⊆ all. Counts are genes carrying the field, across all 128 genomes.
const RSID_SEVERITY_FIELD = {
  all: "rsid__attr_ss",
  PAV: "rsid_PAV__attr_ss",
  PTV: "rsid_PTV__attr_ss",
};

async function tool_variant_genes(args, site) {
  const { rsid, severity = "all", genomes, sample_size = 5 } = args || {};
  if (typeof rsid !== "string" || !/^rs\d{1,20}$/.test(rsid)) {
    throw new Error("variant_genes: 'rsid' must match /^rs\\d+$/ (e.g. rs162569336)");
  }
  const field = RSID_SEVERITY_FIELD[severity];
  if (!field) throw new Error(`variant_genes: severity must be one of ${Object.keys(RSID_SEVERITY_FIELD).join(", ")}`);
  if (!Number.isInteger(sample_size) || sample_size < 0 || sample_size > 50) {
    throw new Error("variant_genes: sample_size must be an integer 0..50");
  }
  const fq = [];
  if (genomes !== undefined) {
    const g = capArray(genomes, 300, "genomes");
    for (const t of g) if (!Number.isInteger(t)) throw new Error("genomes must be integers");
    fq.push(`taxon_id:(${g.join(" OR ")})`);
  }
  const q = `${field}:${solrEscapeValue(rsid)}`;
  const res = await searchFetch(site, {
    q, fq, rows: sample_size, sort: "system_name asc",
    fl: "id,system_name,taxon_id,region,start,end,biotype",
    facet: { field: "system_name", limit: -1, mincount: 1 },
  });
  const ff = res.facet_counts?.facet_fields?.system_name || [];
  const byGenome = [];
  for (let i = 0; i < ff.length; i += 2) byGenome.push({ system_name: ff[i], n_genes: ff[i + 1] });
  return {
    rsid, severity, solr_field: field, query: q,
    n_genes: res.response?.numFound ?? 0,
    n_genomes: byGenome.length,
    by_genome: byGenome,
    sample_genes: res.response?.docs || [],
    note:
      "rsIDs are PROJECTED across the pan-genome, so one rsID maps to the orthologous " +
      "gene in every assembly carrying it: n_genes is a fan-out, not a count of distinct " +
      "variants. PTV (truncating) subset of PAV (protein-altering) subset of all. For full " +
      `docs in one genome, call gene_search with {"fq_field":"${field}","fq_value":"${rsid}"} ` +
      "plus genomes:[<taxon_id>].",
  };
}

// Homology fields are INVERTED: gene B's homology__* lists gene A's id, so one query on
// A's id returns every homolog of A — no second round-trip, no graph traversal.
// The neighborhood modes are two-step, and the seed fields are DIFFERENT INDEX SPACES:
// neighbors_N is keyed on gene_idx, compara_neighbors_N on compara_idx. Seeding the
// compara field with a gene_idx returns a plausible but WRONG answer (22 vs 21 genes
// for SORBI_3001G100000, whose gene_idx is 1059 and compara_idx 1028).
const EXPAND_MODES = {
  orthologs:            { field: "homology__all_orthologs",          seed: "id" },
  one2one:              { field: "homology__ortholog_one2one",       seed: "id" },
  one2many:             { field: "homology__ortholog_one2many",      seed: "id" },
  many2many:            { field: "homology__ortholog_many2many",     seed: "id" },
  paralogs:             { field: "homology__within_species_paralog", seed: "id" },
  gene_split:           { field: "homology__gene_split",             seed: "id" },
  tree:                 { field: "gene_tree",                        seed: "gene_tree" },
  neighborhood:         { field: "neighbors_",                       seed: "gene_idx" },
  compara_neighborhood: { field: "compara_neighbors_",               seed: "compara_idx" },
};

async function tool_expand_gene_set(args, site) {
  const { gene_ids, mode, window = 10, genomes, fl, facet_by_genome = true } = args || {};
  capArray(gene_ids, 50, "gene_ids");
  for (const g of gene_ids) {
    if (typeof g !== "string" || !g || g.length > 128) throw new Error("gene_ids must be non-empty strings of at most 128 chars");
  }
  const spec = EXPAND_MODES[mode];
  if (!spec) throw new Error(`expand_gene_set: mode must be one of ${Object.keys(EXPAND_MODES).join(", ")}`);
  const rows = capRows(args?.rows, { def: 50, max: 200 });
  const twoStep = spec.seed !== "id";
  if (twoStep && ![5, 10, 20].includes(window)) throw new Error("expand_gene_set: window must be 5, 10 or 20");

  let clauses, seeds = null;
  if (!twoStep) {
    clauses = gene_ids.map((g) => `${spec.field}:${solrEscapeValue(g)}`);
  } else {
    const look = await searchFetch(site, {
      q: `id:(${gene_ids.map(solrEscapeValue).join(" OR ")})`,
      fl: `id,${spec.seed}`, rows: gene_ids.length,
    });
    seeds = (look.response?.docs || []).filter((d) => d[spec.seed] !== undefined && d[spec.seed] !== null);
    if (!seeds.length) throw new Error(`expand_gene_set: none of the seed genes has a ${spec.seed} value (mode ${mode})`);
    const fieldName = spec.field.endsWith("_") ? `${spec.field}${window}` : spec.field;
    clauses = seeds.map((d) => `${fieldName}:${solrEscapeValue(d[spec.seed])}`);
  }

  const fq = [];
  if (genomes !== undefined) {
    const g = capArray(genomes, 300, "genomes");
    for (const t of g) if (!Number.isInteger(t)) throw new Error("genomes must be integers");
    fq.push(`taxon_id:(${g.join(" OR ")})`);
  }
  const q = clauses.join(" OR ");
  const res = await searchFetch(site, {
    q, fq, rows, fl: fl || DEFAULT_GENE_FL,
    sort: twoStep ? "gene_idx asc" : "system_name asc",
    ...(facet_by_genome && { facet: { field: "system_name", limit: -1, mincount: 1 } }),
  });
  const ff = res.facet_counts?.facet_fields?.system_name || [];
  const byGenome = [];
  for (let i = 0; i < ff.length; i += 2) byGenome.push({ system_name: ff[i], n_genes: ff[i + 1] });
  return {
    mode, query: q,
    ...(twoStep && { window, seed_field: spec.seed, seeds }),
    n_genes: res.response?.numFound ?? 0,
    n_genomes: byGenome.length,
    by_genome: byGenome,
    genes: res.response?.docs || [],
    note: twoStep
      ? `neighbors_${window}/compara_neighbors_${window} hold the centre gene's own index AND its ±${window} neighbours, so one query returns the whole ${2 * window + 1}-gene window. Seeded from ${spec.seed} — gene_idx and compara_idx are different index spaces.`
      : "Homology fields are inverted, so this is a single query on the seed id, not a traversal.",
  };
}

const RESOLVE_MAX_IDS = 1000;

async function tool_resolve_gene_ids(args, site) {
  const { ids } = args || {};
  capArray(ids, RESOLVE_MAX_IDS, "ids");
  for (const v of ids) {
    if (typeof v !== "string" || !v) throw new Error("every id must be a non-empty string");
    if (v.length > 255) throw new Error(`id longer than 255 chars: ${v.slice(0, 40)}…`);
  }
  const r = await fetch(apiUrl(site, "/gene_lists/validate", {}), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(ids),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`resolve_gene_ids: HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const v = await r.json();
  return {
    ...v,
    counts: {
      submitted: ids.length,
      resolved: v.resolved?.length ?? 0,
      ambiguous: v.ambiguous?.length ?? 0,
      unknown: v.unknown?.length ?? 0,
    },
    note:
      "Matches the stable id AND alt_id (alt_id is indexed lowercased, so case is ignored). " +
      "An input hitting more than one gene lands in 'ambiguous' even if one hit is an exact " +
      "stable id. Feed resolved[].id into gene_search / expand_gene_set / gene_sequence.",
  };
}

async function tool_saved_searches(args, site) {
  const { kind = "views", hash, is_public = true } = args || {};
  if (!["views", "lists"].includes(kind)) throw new Error("saved_searches: kind must be 'views' or 'lists'");
  const rows = capRows(args?.rows, { def: 20, max: 100 });
  const siteKey = userDataSite(site);

  if (kind === "views" && hash) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hash)) throw new Error("saved_searches: bad hash");
    const got = await apiGet(site, "/saved_views", { hash });
    const d = Array.isArray(got) ? got[0] : got;
    if (!d) throw new Error(`saved_searches: no saved view with hash ${hash} (private views need a Bearer token)`);
    return {
      hash, label: d.label ?? null, site: d.site ?? null, createdAt: d.createdAt ?? null,
      filters: d.state?.filters ?? null,
      genomes: d.state?.genomes ?? null,
      note: "Pass 'filters' straight to gene_search, or call gene_search with saved_view_hash.",
    };
  }

  const docs = await apiGet(site, kind === "views" ? "/saved_views" : "/gene_lists",
                            { site: siteKey, isPublic: !!is_public, rows });
  const arr = Array.isArray(docs) ? docs : [];
  return {
    kind, site: siteKey, n: arr.length,
    items: arr.map((d) => ({
      hash: d.hash ?? null, label: d.label ?? null, createdAt: d.createdAt ?? null,
      ...(kind === "lists" ? { n_genes: d.n_genes ?? null } : { has_filters: !!d.state?.filters }),
    })),
    ...(kind === "lists" && {
      warning:
        "Metadata only. A gene list stores a hash, not its member ids; membership lives as " +
        "saved_search tags on gene documents, and q=saved_search:* returns 0 in this release " +
        "(the existing lists were tagged against the previous core). Lists saved against v11 " +
        "will resolve.",
    }),
  };
}

// --- Ensembl REST client (pansite mirror) --------------------------------------
// Deliberately NOT routed through apiGet: this is a different service with different
// failure modes, and one process serves three sites, so a hung Ensembl call must not
// tie up unrelated traffic. Patterns ported from the swagger app's hardened variation
// client (gramene-swagger/api/helpers/primers/variation/client.js: createLru :91-116,
// readCapped :206-232, breaker :265-290, origin-pinned buildUrl :300-330), with its
// tuning constants (primers/config.js:51-83) kept identical so the two age together.
// Release 115 is static, so caching is aggressive. No retry loop by design: timeout +
// breaker + cache, never a thundering herd.
const ENS_BASE = (process.env.GRAMENE_ENSEMBL_BASE || "https://data.gramene.org/pansite-ensembl-115").replace(/\/$/, "");
const ENS = {
  timeoutMs: 8000, maxConcurrent: 4, maxBytes: 1_000_000,
  cacheEntries: 500, cacheTtlMs: 3_600_000,
  breakerFailures: 3, breakerWindowMs: 60_000, breakerOpenMs: 60_000,
};
const ENS_MAX_IDS = 25, ENS_MAX_EXPAND = 10_000, ENS_MAX_REGION_BP = 1_000_000;

const ensState = { cache: new Map(), inflight: new Map(), fails: [], openUntil: 0, active: 0, queue: [] };

function ensCacheGet(key) {
  const hit = ensState.cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) { ensState.cache.delete(key); return undefined; }
  ensState.cache.delete(key); ensState.cache.set(key, hit);   // LRU bump
  return hit.value;
}
function ensCacheSet(key, value) {
  ensState.cache.set(key, { value, expires: Date.now() + ENS.cacheTtlMs });
  while (ensState.cache.size > ENS.cacheEntries) ensState.cache.delete(ensState.cache.keys().next().value);
}
function ensRecordFailure() {
  const now = Date.now();
  ensState.fails = ensState.fails.filter((t) => now - t < ENS.breakerWindowMs);
  ensState.fails.push(now);
  if (ensState.fails.length >= ENS.breakerFailures) {
    ensState.openUntil = now + ENS.breakerOpenMs;
    ensState.fails = [];
  }
}
async function ensAcquire() {
  if (ensState.active < ENS.maxConcurrent) { ensState.active++; return; }
  await new Promise((resolve) => ensState.queue.push(resolve));
  ensState.active++;
}
function ensRelease() {
  ensState.active--;
  const next = ensState.queue.shift();
  if (next) next();
}
// An Ensembl overlap response can be megabytes; stop reading rather than buffering it.
async function ensReadCapped(res, cap) {
  const len = Number(res.headers.get("content-length") || "0");
  if (len > cap) throw new Error(`Ensembl response larger than ${cap} bytes`);
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, cap + 1);
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch {} throw new Error(`Ensembl response larger than ${cap} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function ensUrl(path, params) {
  const u = new URL(String(path).replace(/^\//, ""), ENS_BASE + "/");
  if (u.href.indexOf(ENS_BASE + "/") !== 0) throw new Error("ensembl: refusing off-origin URL");
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== false && v !== "") u.searchParams.set(k, String(v));
  }
  u.searchParams.set("content-type", "application/json");
  return u.href;
}

async function ensFetch(path, params, body) {
  if (Date.now() < ensState.openUntil) {
    throw new Error("Ensembl REST is temporarily unavailable (circuit open after repeated failures); retry in ~60s");
  }
  const url = ensUrl(path, params);
  const key = (body ? "POST " : "GET ") + url + (body ? "\n" + JSON.stringify(body) : "");
  const cached = ensCacheGet(key);
  if (cached !== undefined) return cached;
  if (ensState.inflight.has(key)) return ensState.inflight.get(key);

  const run = (async () => {
    await ensAcquire();
    try {
      const r = await fetch(url, {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
          ...(body && { "Content-Type": "application/json" }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ENS.timeoutMs),
      });
      const text = await ensReadCapped(r, ENS.maxBytes);
      if (!r.ok) {
        // Error bodies are not always JSON — /map/translation returns an HTML 500.
        let msg = text.slice(0, 200);
        try { msg = JSON.parse(text).error || msg; } catch {}
        if (r.status === 429 || r.status >= 500) ensRecordFailure();
        throw new Error(`Ensembl REST HTTP ${r.status} on ${path}: ${msg}`);
      }
      const value = JSON.parse(text);
      ensCacheSet(key, value);
      return value;
    } catch (e) {
      if (e?.name === "TimeoutError" || /abort|fetch failed|ECONN|network/i.test(e?.message || "")) ensRecordFailure();
      throw e;
    } finally {
      ensRelease();
      ensState.inflight.delete(key);
    }
  })();
  ensState.inflight.set(key, run);
  return run;
}

// sorghum_tx430nano is a CONTIG assembly (Contig_1, Contig_10 …) with no chromosomes,
// so a chr:start-end request against it fails with "No slice found". Validate first.
async function ensAssertRegion(species, region) {
  const info = await ensFetch(`/info/assembly/${encodeURIComponent(species)}`, {});
  const names = new Set((info.top_level_region || []).map((r) => String(r.name)));
  if (names.size && !names.has(String(region))) {
    const sample = [...names].slice(0, 5).join(", ");
    throw new Error(`region '${region}' is not a top-level region of ${species} (it has ${names.size}, e.g. ${sample})`);
  }
}

// species= is effectively mandatory: without it Ensembl scans all 267 cores — measured
// 6.64s vs 0.08s, and one cold species-less call returned 502 after 60s. One Solr query
// gets system_name for the whole batch.
async function ensSpeciesForGenes(site, geneIds) {
  const res = await searchFetch(site, {
    q: `id:(${geneIds.map(solrEscapeValue).join(" OR ")})`,
    fl: "id,system_name", rows: geneIds.length,
  });
  const bySpecies = new Map();
  const found = new Set();
  for (const d of res.response?.docs || []) {
    if (!d.system_name) continue;
    found.add(d.id);
    if (!bySpecies.has(d.system_name)) bySpecies.set(d.system_name, []);
    bySpecies.get(d.system_name).push(d.id);
  }
  const missing = geneIds.filter((g) => !found.has(g));
  if (!bySpecies.size) {
    throw new Error(`gene_sequence: none of those ids are in this index — run resolve_gene_ids first (${missing.slice(0, 3).join(", ")}…)`);
  }
  return { bySpecies, missing };
}

async function tool_gene_sequence(args, site) {
  const {
    gene_ids, region, species, type = "genomic",
    expand_5prime = 0, expand_3prime = 0, mask, multiple_sequences = true,
  } = args || {};
  if (!["genomic", "cds", "cdna", "protein"].includes(type)) throw new Error(`gene_sequence: bad type '${type}'`);
  if (mask !== undefined && !["hard", "soft"].includes(mask)) throw new Error("gene_sequence: mask must be 'hard' or 'soft'");
  for (const [n, v] of [["expand_5prime", expand_5prime], ["expand_3prime", expand_3prime]]) {
    if (!Number.isInteger(v) || v < 0 || v > ENS_MAX_EXPAND) throw new Error(`gene_sequence: ${n} must be an integer 0..${ENS_MAX_EXPAND}`);
  }
  if (!!gene_ids === !!region) throw new Error("gene_sequence: pass exactly one of 'gene_ids' or 'region'");

  if (region) {
    const { species: sp, region: r, start, end, strand = 1 } = region || {};
    if (typeof sp !== "string" || !/^[a-z0-9_]{1,64}$/.test(sp)) throw new Error("gene_sequence: region.species is required (Ensembl system_name)");
    if (typeof r !== "string" || !r) throw new Error("gene_sequence: region.region is required");
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) throw new Error("gene_sequence: bad region.start/region.end");
    if (end - start > ENS_MAX_REGION_BP) throw new Error(`gene_sequence: region wider than ${ENS_MAX_REGION_BP} bp`);
    if (![1, -1].includes(strand)) throw new Error("gene_sequence: region.strand must be 1 or -1");
    await ensAssertRegion(sp, r);
    const got = await ensFetch(`/sequence/region/${encodeURIComponent(sp)}/${encodeURIComponent(r)}:${start}..${end}:${strand}`,
                               { mask, expand_5prime: expand_5prime || undefined, expand_3prime: expand_3prime || undefined });
    return { species: sp, region: `${r}:${start}-${end}`, strand, length: (got.seq || "").length, ...got };
  }

  capArray(gene_ids, ENS_MAX_IDS, "gene_ids");
  for (const g of gene_ids) if (typeof g !== "string" || !g || g.length > 128) throw new Error("gene_ids must be non-empty strings");

  let bySpecies, missing = [];
  if (species) {
    if (!/^[a-z0-9_]{1,64}$/.test(species)) throw new Error("gene_sequence: 'species' must be an Ensembl system_name (e.g. sorghum_bicolor)");
    bySpecies = new Map([[species, gene_ids]]);
  } else {
    ({ bySpecies, missing } = await ensSpeciesForGenes(site, gene_ids));
  }

  const sequences = [];
  for (const [sp, ids] of bySpecies) {
    const got = await ensFetch("/sequence/id", {
      species: sp, type,
      mask, expand_5prime: expand_5prime || undefined, expand_3prime: expand_3prime || undefined,
      // Without this, type != genomic on a multi-transcript gene is a hard 400. Setting
      // it turns each response into an array, which is why we always normalize below.
      ...(type !== "genomic" && multiple_sequences && { multiple_sequences: 1 }),
    }, { ids });
    for (const seq of (Array.isArray(got) ? got : [got])) {
      sequences.push({
        species: sp,
        query: seq.query ?? null,
        id: seq.id ?? null,
        molecule: seq.molecule ?? type,
        length: (seq.seq || "").length,
        seq: seq.seq ?? null,
      });
    }
  }
  return {
    type, n_sequences: sequences.length,
    total_bp: sequences.reduce((a, x) => a + x.length, 0),
    ...(missing.length && { not_in_index: missing }),
    sequences,
    gotchas: [
      "protein/cds responses carry the TRANSCRIPT or TRANSLATION id in 'id'; the id you asked for is echoed in 'query'.",
      "canonical_transcript from /lookup/id has a TRAILING DOT ('SORBI_3004G085600.1.') — strip it before reuse.",
      "this mirror has NO Compara (/info/comparas is empty), so /homology and /genetree do not work: use expand_gene_set for orthologs and paralogs.",
    ],
  };
}

const TOOL_REGISTRY = {
  gene_search: {
    definition: {
      name: "gene_search",
      description: [
        "Search SorghumBase genes with the SAME filter tree the web UI uses. Start here for",
        "anything expressible as a filter; it is the only tool that can run a saved view.",
        "",
        "Routing:",
        "  free text ('what genes relate to drought?') -> solr_suggest FIRST, then paste the",
        "    returned fq_field/fq_value in here as a leaf",
        "  coordinates -> genes_in_region      homology -> expand_gene_set",
        "  one rsID    -> variant_genes        raw Solr -> solr_search",
        "  one gene's full expression profile -> mongo_find(collection:'expression_attributes')",
        "",
        "Filter tree. Leaf: {fq_field, fq_value}. Branch: {operation:'AND'|'OR', children:[…]}.",
        "Any node may carry negate:true (applies to the whole subtree) and",
        "expand:'orthologs'|'paralogs'|'neighborhood' (graph-expands that node's match set).",
        "",
        "Worked leaves (counts verified against this release):",
        "  expression, categorical",
        "    {fq_field:'expr_class__attr_ss',        fq_value:'tissue_specific'}",
        "    {fq_field:'expr_specific_to__attr_ss',  fq_value:'root'}       # 16 organs",
        "    {fq_field:'expr_organ_level__attr_ss',  fq_value:'leaf:high'}  # ~16,638 genes",
        "      pass organ:level RAW — the colon is escaped for you",
        "    {fq_field:'expressed_in_gxa_attr_ss',   fq_value:'E-MTAB-5956'}",
        "      note the SINGLE underscore before attr_ss, unlike every other expr_* field",
        "  expression, numeric (not in the suggestion index — only reachable here)",
        "    {fq_field:'expr_tau__attr_f',               fq_value:'[0.9 TO *]'}",
        "    {fq_field:'expr_max_tpm__attr_f',           fq_value:'[100 TO *]'}",
        "    {fq_field:'expr_n_organs_detected__attr_i', fq_value:'[10 TO *]'}",
        "  MAKER gene-model quality (DOUBLE underscores)",
        "    {fq_field:'MAKER__AED__attr_f', fq_value:'[0 TO 0.1]'}  # ~259,782 high-confidence",
        "    AED 0 = fully evidence-supported, 1 = unsupported. For the distribution use",
        "    stats:['MAKER__AED__attr_f'] with output:'facets', not a facet (it is a float).",
        "  variants   {fq_field:'rsid_PTV__attr_ss', fq_value:'rs872208282'}",
        "  ontology   {fq_field:'GO__ancestors', fq_value:'6950'}  # integer ids",
        "",
        "genomes:[…] takes SYNTHETIC per-assembly taxon ids (4558006 …, from /maps), not NCBI",
        "ids, and is applied as a filter query — never put it in the tree.",
        "",
        "output: 'docs' (default) | 'facets' (rows:0 + facet counts, for whole-set questions)",
        "| 'count' | 'bed' (genome-browser track for the matched genes, max 5000).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          filters: { type: "object", description: "Filter tree. Leaf {fq_field,fq_value}; branch {operation,children}; optional negate/expand on any node." },
          saved_view_hash: { type: "string", description: "Run a shared saved view's stored filter tree. Mutually exclusive with 'filters'." },
          genomes: { type: "array", items: { type: "integer" }, maxItems: 300, description: "Synthetic per-assembly taxon ids; omit for all genomes." },
          extra_fq: { type: "array", items: { type: "string" }, maxItems: 10 },
          fl: { type: "string", description: "Field list. Default omits attribute fields — name them explicitly to get rsid/expr/MAKER values back." },
          rows: { type: "integer", minimum: 0, maximum: 200, description: "Default 50, capped at 200." },
          start: { type: "integer", minimum: 0 },
          sort: { type: "string" },
          facets: { type: "array", items: { type: "string" }, maxItems: 5 },
          facet_limit: { type: "integer", description: "Default 50; -1 for unlimited." },
          stats: { type: "array", items: { type: "string" }, maxItems: 5, description: "Numeric fields for min/max/mean/stddev." },
          output: { type: "string", enum: ["docs", "facets", "count", "bed"] },
          bed_feature: { type: "string", enum: ["gene", "transcript", "exon", "intron", "CDS", "utr5", "utr3"] },
          bed_combiner: { type: "string", enum: ["canonical", "all"] },
        },
      },
    },
    handler: tool_gene_search,
  },

  variant_genes: {
    definition: {
      name: "variant_genes",
      description: [
        "Find the genes a dbSNP-style rsID falls in, summarized by genome.",
        "",
        "rsIDs are PROJECTED across the pan-genome, so one rsID lands on the orthologous gene",
        "in every assembly carrying it: rs872208282 hits 327 genes across 100 genomes. The",
        "returned n_genes is therefore a fan-out, NOT a count of distinct variants. This tool",
        "returns per-genome counts plus a small sample instead of 327 near-identical documents.",
        "",
        "severity is a ladder, PTV subset of PAV subset of all:",
        "  all  rsid__attr_ss      any overlapping variant",
        "  PAV  rsid_PAV__attr_ss  protein-altering (missense, in-frame indel, and all PTVs)",
        "  PTV  rsid_PTV__attr_ss  protein-truncating (stop gained/lost, start lost,",
        "                          frameshift, splice site)",
        "",
        "For full gene documents in one genome, use gene_search with the same field and value",
        "plus genomes:[<taxon_id>]. To discover valid rsIDs, solr_suggest returns them under",
        "the 'Variants: rsID' category.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          rsid: { type: "string", description: "e.g. rs162569336" },
          severity: { type: "string", enum: ["all", "PAV", "PTV"], description: "Default 'all'." },
          genomes: { type: "array", items: { type: "integer" }, maxItems: 300 },
          sample_size: { type: "integer", minimum: 0, maximum: 50, description: "Example genes to return. Default 5." },
        },
        required: ["rsid"],
      },
    },
    handler: tool_variant_genes,
  },

  expand_gene_set: {
    definition: {
      name: "expand_gene_set",
      description: [
        "Expand seed genes to their homologs, gene-tree family, or genomic neighbourhood.",
        "",
        "modes:",
        "  orthologs   all orthologs (one2one + one2many + many2many)",
        "  one2one / one2many / many2many   a single ortholog class",
        "  paralogs    within-species paralogs        gene_split  split-gene relations",
        "  tree        every gene in the seed's Compara tree (whole family)",
        "  neighborhood          +/- window genes in GENOME order",
        "  compara_neighborhood  +/- window genes in COMPARA order (syntenic, crosses genomes)",
        "",
        "The homology fields are INVERTED — a gene's record lists the ids it is a homolog OF —",
        "so this is one query per seed, not a traversal. The two neighbourhood modes are seeded",
        "from different index spaces (gene_idx vs compara_idx) and the tool picks the right one;",
        "mixing them returns a plausible but wrong answer.",
        "",
        "window is 5, 10 or 20 and returns 2*window+1 genes (the seed plus its neighbours).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
          mode: { type: "string", enum: ["orthologs", "one2one", "one2many", "many2many", "paralogs", "gene_split", "tree", "neighborhood", "compara_neighborhood"] },
          window: { type: "integer", enum: [5, 10, 20], description: "Neighbourhood modes only. Default 10." },
          genomes: { type: "array", items: { type: "integer" }, maxItems: 300 },
          fl: { type: "string" },
          rows: { type: "integer", minimum: 0, maximum: 200 },
          facet_by_genome: { type: "boolean", description: "Per-genome counts. Default true." },
        },
        required: ["gene_ids", "mode"],
      },
    },
    handler: tool_expand_gene_set,
  },

  gene_sequence: {
    definition: {
      name: "gene_sequence",
      description: [
        "Fetch sequence from the Ensembl REST mirror: genomic, CDS, cDNA or protein for genes,",
        "or any genomic interval. Covers all 128 genomes in this release.",
        "",
        "Two ways to call it:",
        "  gene_ids:[…]  up to 25 ids; species is inferred from the index automatically",
        "  region:{species,region,start,end,strand}  fastest path when you already have",
        "                                            coordinates (validated against the assembly)",
        "",
        "expand_5prime / expand_3prime add flanking sequence (promoter analysis); mask:'hard'",
        "replaces repeats with N, mask:'soft' lower-cases them.",
        "",
        "This mirror has NO Compara, so it cannot answer homology — use expand_gene_set. It",
        "also has no gene symbols or xrefs: use solr_suggest / gene_search for those.",
        "Protein and CDS responses identify the transcript or translation in 'id'; the id you",
        "asked for comes back in 'query'.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          gene_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 },
          region: { type: "object", description: "{species, region, start, end, strand?} — species is an Ensembl system_name such as sorghum_bicolor." },
          species: { type: "string", description: "Optional for gene_ids (inferred); supplying it skips a lookup." },
          type: { type: "string", enum: ["genomic", "cds", "cdna", "protein"], description: "Default 'genomic'." },
          expand_5prime: { type: "integer", minimum: 0, maximum: 10000 },
          expand_3prime: { type: "integer", minimum: 0, maximum: 10000 },
          mask: { type: "string", enum: ["hard", "soft"] },
          multiple_sequences: { type: "boolean", description: "Default true; required for non-genomic types on multi-transcript genes." },
        },
      },
    },
    handler: tool_gene_sequence,
  },

  resolve_gene_ids: {
    definition: {
      name: "resolve_gene_ids",
      description: [
        "Normalize gene identifiers before using them anywhere else. Resolves both current",
        "stable ids and alternate/legacy ids (case-insensitively), and separates the input into",
        "resolved / ambiguous / unknown.",
        "",
        "Run this first whenever ids come from a paper, a spreadsheet, or an older annotation —",
        "alternate ids are NOT matchable by a plain field query, so an unresolved id silently",
        "returns nothing. Example: Sb01g000200 resolves to SORBI_3001G000100.",
        "",
        "Up to 1000 ids per call.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 },
        },
        required: ["ids"],
      },
    },
    handler: tool_resolve_gene_ids,
  },

  saved_searches: {
    definition: {
      name: "saved_searches",
      description: [
        "Discover saved views and gene lists that people have published on this site.",
        "",
        "kind:'views' lists shared searches; pass a hash to get one, including its stored filter",
        "tree, which you can hand straight to gene_search (or use gene_search's saved_view_hash).",
        "This is the way to reproduce or extend someone else's analysis.",
        "",
        "kind:'lists' returns gene-list METADATA only in this release — a list stores a hash",
        "rather than its members, and the tags that recorded membership are not present in the",
        "current gene index.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["views", "lists"], description: "Default 'views'." },
          hash: { type: "string", description: "views only: fetch one view by its share token." },
          is_public: { type: "boolean", description: "Default true." },
          rows: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
    handler: tool_saved_searches,
  },

  solr_search: {
    definition: {
      name: "solr_search",
      description: [
        `Query the Gramene search index (the public /search endpoint, which wraps the genes Solr core).`,
        `Returns matching gene documents in standard Solr response shape.`,
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
        `    to the /experiments and /assays collection endpoints.`,
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
        `Calls the public /suggest endpoint, which applies its own field boosts (name, ids, synonym,`,
        `text) and groups matches by category. Pass 'term' for a free-text query, or 'q' for a`,
        `field-qualified Solr query (e.g. 'name:"Sorghum bicolor"'). 'term' takes precedence.`,
        ``,
        `Response shape: Solr "grouped" envelope — data.grouped.category.groups[].doclist.docs[].`,
        `Each suggestion doc carries fq_field, fq_value, num_genes (the size of the gene set that`,
        `filter would yield), category, display_name, and a relevance score.`,
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
          term: { type: "string", description: "Free-text search term — handed verbatim to the API's boosted suggester." },
          q:    { type: "string", description: "Field-qualified Solr query (e.g. 'name:\"Sorghum bicolor\"'). Overridden by 'term' if both are provided." },
          fq:   { type: "array", items: { type: "string" }, description: "Filter query strings (e.g. ['category:Trait Ontology'])." },
          rows: { type: "integer", minimum: 0, maximum: 1000, description: "Max results to return (default 10)." },
          start: { type: "integer", minimum: 0, description: "Offset for pagination." },
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
        "Fetch detailed records from a Gramene collection (genes, taxonomy, GO, PO, TO, qtls, maps,",
        "germplasm, experiments, assays, expression, pathways, domains, genetrees) by ID or by",
        "simple field-equality filters. Use AFTER you already have a specific ID — typically",
        "resolved via solr_suggest first. Do NOT use mongo_find for free-text discovery; that's",
        "solr_suggest's job.",
        "",
        "Supported filter shapes (mapped to the public API's /<collection> endpoint):",
        "  { _id: <id> }                       → idList=<id>",
        "  { _id: { $in: [a, b, c] } }         → idList=a,b,c",
        "  { field: <value> }                   → field=<value>     (top-level equality)",
        "  { field: { $in: [v1, v2] } }         → field=v1&field=v2 ($in over a single field)",
        "  Combinations: { _id: …, field1: …, field2: { $in: […] } }   → ANDed together",
        "",
        "NOT supported (operators that the public REST API does not expose):",
        "  $gt, $gte, $lt, $lte, $ne, $exists, $regex, $where, $expr, $and, $or, $nor, $not,",
        "  dotted-path keys, nested filters beyond a single $in.",
        "For those cases use solr_search (which exposes Solr fq range/regex syntax on the genes",
        "index) instead.",
        "",
        "Common patterns:",
        "  - Genome assembly metadata (Compara membership): filter:{ in_compara: true } on 'maps'",
        "  - Ontology term lookup by ID: prefer mongo_lookup_by_ids over an ad-hoc find().",
        "  - Experiment metadata: filter:{ _id: { $in: [<exp_ids>] } } on 'experiments' or 'assays'",
        "",
        "Filter parameter is `filter` (NOT `query`). Passing `query: {...}` is silently ignored.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", enum: COLLECTIONS },
          filter: { type: "object", description: "Restricted MongoDB-style filter (see description)" },
          projection: { type: "object", description: "Inclusion projection ({ field: 1, ... }). Exclusion of fields other than _id is not supported." },
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
      description: "List all Gramene collections reachable via the public /<collection> API endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          nameOnly: { type: "boolean", description: "Kept for compatibility — the API always returns name-only entries." },
        },
      },
    },
    handler: tool_mongo_list_collections,
  },
  mongo_lookup_by_ids: {
    definition: {
      name: "mongo_lookup_by_ids",
      description: "Fetch documents by _id from a Gramene collection. Useful for resolving search-index ancestor IDs to their labels.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", enum: COLLECTIONS },
          ids: { type: "array", items: { type: ["number", "string"] }, description: "Array of _id values (numbers for ontology collections, strings for genes/maps/etc.)" },
          projection: { type: "object", description: "Inclusion projection ({ field: 1, ... })." },
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
      description: "Return field-crosswalk metadata describing how search-index fields map to collection endpoints (which fields you can fq-filter on, and which collection holds the joined document).",
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
        `Retrieve baseline and differential expression for a list of gene IDs. Reads the encoded`,
        `expression fields from the gene documents (*__expr, *_l2fc_attr_f, *_pval_attr_f) via`,
        `the /search endpoint, then joins with experiment + assay metadata fetched on demand from`,
        `the /experiments and /assays collection endpoints (memoized per-process).`,
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
        `Uses Ensembl VEP (Variant Effect Prediction) annotations indexed as dynamic fields`,
        `(VEP__*) on the gene documents. For each gene, returns germplasm accessions that`,
        `carry predicted high-impact variants grouped by:`,
        `  - VEP consequence (e.g. 'stop gained', 'splice acceptor variant')`,
        `  - Zygosity (homozygous / heterozygous)`,
        `  - Study/population (e.g. 'Sorghum Genomics Toolbox', 'Boatwright SAP', 'Purdue EMS')`,
        `  - Study type (EMS = ethyl-methanesulfonate mutagenesis; NAT = natural diversity)`,
        ``,
        `Also returns the merged EMS and NAT totals from VEP__merged__EMS/NAT__attr_ss.`,
        ``,
        `Germplasm metadata (pub_id, stock_center, subpopulation, genebank URL) is enriched`,
        `from the /germplasm collection endpoint when available.`,
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
            description: "Whether to enrich accession IDs with germplasm metadata (pub_id, stock_center, subpopulation, genebank URL) from the /germplasm endpoint. Default true. Set false for a count-only summary.",
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
        "Return PubMed and DOI cross-references for a list of genes from the Gramene search index.",
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
async function handleJsonRpc(msg, site, sessionId = null) {
  const { jsonrpc, id, method, params } = msg || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }

  // Lifecycle
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return jsonRpcResult(id, {
      protocolVersion: negotiated,
      capabilities: {
        tools: SERVER_CAPABILITIES.tools,
        prompts: SERVER_CAPABILITIES.prompts,
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: siteInstructions(site),
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
      log({ event: "tool_call", site: site.id, tool: name, status: "unknown_tool" });
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
    }

    const t0 = Date.now();
    try {
      const result = await entry.handler(toolArgs, site);
      const text = capResultText(result);
      log({ event: "tool_call", site: site.id, tool: name, args: toolArgs, status: "ok", ms: Date.now() - t0, bytes: Buffer.byteLength(text), ...(sessionId && { session: sessionId }) });
      return jsonRpcResult(id, {
        content: [{ type: "text", text }],
      });
    } catch (e) {
      log({ event: "tool_call", site: site.id, tool: name, args: toolArgs, status: "error", error: e?.message || String(e), ms: Date.now() - t0, ...(sessionId && { session: sessionId }) });
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
      log({ event: "prompt_get", site: site.id, prompt: name, status: "unknown_prompt" });
      return jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
    }
    try {
      const result = getPromptMessages(name, promptArgs || {});
      log({ event: "prompt_get", site: site.id, prompt: name, args: promptArgs, status: "ok", ...(sessionId && { session: sessionId }) });
      return jsonRpcResult(id, result);
    } catch (e) {
      log({ event: "prompt_get", site: site.id, prompt: name, args: promptArgs, status: "error", error: e?.message || String(e), ...(sessionId && { session: sessionId }) });
      return jsonRpcError(id, -32602, e?.message || String(e));
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// --- Dashboard HTML ---
// site === null renders the all-sites dashboard.
function dashboardHtml(site) {
  const scope = site ? site.id : "all sites";
  const dataPath = site ? `/mcp/${site.id}/usage/data` : "/mcp/usage/data";
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
<h1>Gramene MCP — Usage Dashboard (${scope})</h1>
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
  <table><thead><tr><th>Time</th><th>Site</th><th>Session</th><th>Tool</th><th>Status</th><th>ms</th><th>Args</th></tr></thead>
  <tbody id="recent"></tbody></table>
</section>
<p class="meta" id="meta"></p>
<script>
let countdown = 30;
async function load() {
  try {
    const d = await fetch('${dataPath}').then(r => r.json());
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
      : '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:16px">No session data yet — sessions are tracked via Mcp-Session-Id header</td></tr>';

    document.getElementById('recent').innerHTML = d.recent.map(e => {
      const args = e.args ? JSON.stringify(e.args, null, 0).slice(0, 200) : '';
      const t = new Date(e.ts).toLocaleString();
      const sid = e.session ? e.session.slice(0,8) + '…' : '—';
      return '<tr><td>' + t + '</td>' +
        '<td>' + (e.site||'—') + '</td>' +
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
//
// Routes (site = null when the path names no site):
//   /mcp[/<site>]              MCP endpoint; bare /mcp serves DEFAULT_SITE
//   /mcp[/<site>]/usage        usage dashboard; bare /mcp/usage covers all sites
//   /mcp[/<site>]/usage/data   dashboard stats JSON
function matchRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.shift() !== "mcp") return null;
  let site = null;
  if (parts.length > 0 && parts[0] !== "usage") {
    site = SITES.get(parts.shift());
    if (!site) return null;
  }
  const view = parts.length === 0 ? "mcp" : parts.join("/");
  return ["mcp", "usage", "usage/data"].includes(view) ? { site, view } : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const cors = corsHeaders(req);

    // CORS preflight — always answer, regardless of Origin allowlist. The
    // browser uses the response headers to decide whether to send the real
    // request; the real request still goes through originAllowed.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    const route = matchRoute(url.pathname);
    if (!route) return send(res, 404, { error: "Not Found" }, cors);

    // Dashboard routes (GET only, no CORS restriction needed — read-only)
    if (route.view === "usage" && req.method === "GET") {
      const html = dashboardHtml(route.site);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        ...cors,
      });
      return res.end(html);
    }

    if (route.view === "usage/data" && req.method === "GET") {
      let events = LOG_FILE ? await readLogFile() : logBuffer;
      if (route.site) events = events.filter((e) => e.site === route.site.id);
      const stats = computeStats(events);
      const body = JSON.stringify(stats);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        ...cors,
      });
      return res.end(body);
    }

    if (route.view !== "mcp") return send(res, 404, { error: "Not Found" }, cors);
    const site = route.site || DEFAULT_SITE;

    // Block state-changing or session-handshake requests from disallowed
    // origins. The preflight is already answered above; this guards the
    // actual MCP traffic against DNS-rebinding / cross-origin abuse.
    if (!originAllowed(req)) return send(res, 403, null, cors);

    // GET /mcp
    //   - If the client asks for an SSE stream (Accept: text/event-stream),
    //     the MCP Streamable HTTP spec requires 405 when the server doesn't
    //     offer one. We don't, so return 405.
    //   - Otherwise, serve a human-friendly discovery document so that
    //     browsers / curl visits to the URL return something useful.
    if (req.method === "GET") {
      const accept = String(req.headers.accept || "");
      if (accept.includes("text/event-stream")) {
        return send(res, 405, { error: "Method Not Allowed" }, {
          ...cors,
          Allow: "POST, OPTIONS",
        });
      }
      return send(res, 200, getServerDiscoveryDoc(site), {
        ...cors,
        "Cache-Control": "no-store",
      });
    }

    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" }, cors);

    const msg = await readJson(req);

    // Session management: assign on initialize, validate on subsequent calls.
    let sessionId = req.headers["mcp-session-id"] || req.headers["x-mcp-session"] || null;
    if (msg?.method === "initialize") {
      pruneOldSessions();
      sessionId = randomUUID();
      activeSessions.set(sessionId, { site: site.id, created: new Date().toISOString(), lastSeen: new Date().toISOString() });
      log({ event: "session_start", site: site.id, session: sessionId });
    } else {
      sessionId = getOrCreateSession(sessionId, site);
      if (sessionId) activeSessions.get(sessionId).lastSeen = new Date().toISOString();
    }

    const sessionHeaders = {
      ...cors,
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    };
    const reply = await handleJsonRpc(msg, site, sessionId);

    if (reply === null) return send(res, 202, null, sessionHeaders);   // notification → no body
    return send(res, 200, reply, sessionHeaders);
  } catch (e) {
    return send(res, 400, jsonRpcError(null, -32700, "Parse error", String(e?.message || e)), corsHeaders(req));
  }
});

// --- Transport selection ---
// stdio: --stdio CLI flag or MCP_STDIO=1 env var. Reads newline-delimited
// JSON-RPC from stdin, writes responses to stdout. Used by Claude Desktop
// and Claude Code to launch the server as a child process.
const USE_STDIO = process.argv.includes("--stdio") || process.env.MCP_STDIO === "1";

if (USE_STDIO) {
  runStdio();
} else {
  server.listen(PORT, HOST, () => {
    console.error(`Gramene MCP server listening on http://${HOST}:${PORT}/mcp`);
    for (const s of SITES.values()) {
      console.error(`  /mcp/${s.id} → ${s.apiBase}${s === DEFAULT_SITE ? "  (also /mcp)" : ""}`);
    }
  });
}

// Graceful shutdown
function shutdown() {
  console.error("Shutting down…");
  if (!USE_STDIO) server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- stdio transport ---
//
// One JSON-RPC message per line, both directions. Anything written to stdout
// that isn't a response will corrupt the stream — all logging goes to stderr.
// Serves one site: `--site <id>` picks it, otherwise DEFAULT_SITE.
function runStdio() {
  const i = process.argv.indexOf("--site");
  const site = i >= 0 ? SITES.get(process.argv[i + 1]) : DEFAULT_SITE;
  if (!site) {
    console.error(`Unknown --site "${process.argv[i + 1]}". Configured: ${[...SITES.keys()].join(", ")}`);
    process.exit(1);
  }
  console.error(`Gramene MCP server on stdio. Site ${site.id} backed by ${site.apiBase}`);
  process.stdin.setEncoding("utf8");

  // stdio is single-session — synthesise a stable id for log correlation.
  const sessionId = randomUUID();
  activeSessions.set(sessionId, {
    site: site.id,
    created: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  });

  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      handleStdioLine(line, site, sessionId);
    }
  });

  process.stdin.on("end", () => process.exit(0));
}

async function handleStdioLine(line, site, sessionId) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    const err = jsonRpcError(null, -32700, "Parse error", String(e?.message || e));
    process.stdout.write(JSON.stringify(err) + "\n");
    return;
  }
  try {
    const reply = await handleJsonRpc(msg, site, sessionId);
    if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
    // null reply = notification; nothing to send.
    if (sessionId) activeSessions.get(sessionId).lastSeen = new Date().toISOString();
  } catch (e) {
    const err = jsonRpcError(msg?.id ?? null, -32603, "Internal error", String(e?.message || e));
    process.stdout.write(JSON.stringify(err) + "\n");
  }
}
