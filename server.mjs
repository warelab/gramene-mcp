import http from "node:http";
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
const LOGGING_ENABLED = process.env.MCP_LOG !== "false";
function log(event) {
  if (!LOGGING_ENABLED) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
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
        gene_tree: {
          type: "string",
          description: "Gene tree identifier; use as seed query for graph traversal, e.g. gene_tree:SB10GT_332720"
        },
        pan_tree: {
          type: "string",
          description: "Pan-gene tree identifier"
        },
        "homology__*": {
          type: "string[]",
          dynamicField: true,
          description: "Homology relationships, e.g. homology__oryza_sativa"
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
        description: "Gene metadata. _id = gene stable ID. Has location {region, start, end, strand, map}, xrefs, biotype, taxon_id, system_name, gene_idx." },
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
  } = args || {};

  if (!q || typeof q !== "string") {
    throw new Error(`Solr ${endpoint} requires a non-empty string 'q'`);
  }

  const url = solrUrl(core, endpoint, { q, fq, fl, rows, start, sort, defType });
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
  },
  required: ["q"],
};

const TOOL_REGISTRY = {
  solr_search: {
    definition: {
      name: "solr_search",
      description: `Query the Solr genes core (${SOLR_GENES_CORE}) via /query endpoint. Returns matching gene documents.`,
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
};

const TOOLS = Object.values(TOOL_REGISTRY).map((t) => t.definition);

// --- MCP request handler ---
async function handleJsonRpc(msg) {
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
      log({ event: "tool_call", tool: name, args: toolArgs, status: "ok", ms: Date.now() - t0 });
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      log({ event: "tool_call", tool: name, args: toolArgs, status: "error", error: e?.message || String(e), ms: Date.now() - t0 });
      return jsonRpcError(id, -32000, `Tool error: ${e?.message || String(e)}`);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  try {
    if (!originAllowed(req)) return send(res, 403, null);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/mcp") return send(res, 404, { error: "Not Found" });
    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });

    const msg = await readJson(req);
    const reply = await handleJsonRpc(msg);

    if (reply === null) return send(res, 202, null);   // notification → no body
    return send(res, 200, reply);
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
