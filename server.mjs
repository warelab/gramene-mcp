import http from "node:http";
import { MongoClient } from "mongodb";

/**
 * Env:
 *   MCP_HOST=127.0.0.1
 *   MCP_PORT=8787
 *   MCP_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
 *
 *   SOLR_BASE_URL=http://localhost:8983/solr
 *   SOLR_GENES_CORE=genes
 *   SOLR_SUGGESTIONS_CORE=suggestions
 *
 *   MONGO_URI=mongodb://localhost:27017
 *   MONGO_DB=mydb
 */

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || "8787");

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

// --- Mongo (lazy connect) ---
const mongoClient = new MongoClient(MONGO_URI);
let mongoReady = false;
async function db() {
  if (!mongoReady) {
    await mongoClient.connect();
    mongoReady = true;
  }
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
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("Empty body");
  return JSON.parse(raw);
}

function originAllowed(req) {
  // If Origin is present and invalid => 403 (DNS rebinding mitigation)
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.size === 0) {
    return (
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:")
    );
  }
  return ALLOWED_ORIGINS.has(origin);
}

const KB_RELATIONS = {
  solr: {
    genes: {
      core: process.env.SOLR_GENES_CORE || "genes",
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
        }
      }
    },
    suggestions: {
      core: process.env.SOLR_SUGGESTIONS_CORE || "suggestions",
      fields: {
        fq_field: { type: "string" },
        fq_value: { type: "string|int" }
      }
    }
  },
  mongo: {
    collections: {
      taxonomy: { key: "_id", type: "int", labelField: "name" },
      gene_ontology: { key: "_id", type: "int", labelField: "name" },
      plant_ontology: { key: "_id", type: "int", labelField: "name" },
      trait_ontology: { key: "_id", type: "int", labelField: "name" },
      domains: { key: "_id", type: "int", labelField: "name" },
      pathways: { key: "_id", type: "int", labelField: "name" }
    }
  }
};

async function tool_kb_relations() {
  return KB_RELATIONS;
}

function solrQueryUrl(core, params) {
  const url = new URL(
    `${SOLR_BASE_URL.replace(/\/$/, "")}/${encodeURIComponent(core)}/query`
  );
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  });
  url.searchParams.set("wt", "json");
  return url.toString();
}

function solrSelectUrl(core, params) {
  const url = new URL(
    `${SOLR_BASE_URL.replace(/\/$/, "")}/${encodeURIComponent(core)}/select`
  );
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  });
  url.searchParams.set("wt", "json");
  return url.toString();
}

async function solrQuery(core, args) {
  const {
    q,
    fq,
    fl,
    rows = 10,
    start = 0,
    sort,
    defType,
  } = args || {};

  if (!q || typeof q !== "string") throw new Error("Solr select requires string 'q'");

  const url = solrQueryUrl(core, { q, fq, fl, rows, start, sort, defType });
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Solr HTTP ${r.status}: ${txt || r.statusText}`);
  }
  return r.json();
}

async function solrSelect(core, args) {
  const {
    q,
    fq,
    fl,
    rows = 10,
    start = 0,
    sort,
    defType,
  } = args || {};

  if (!q || typeof q !== "string") throw new Error("Solr select requires string 'q'");

  const url = solrSelectUrl(core, { q, fq, fl, rows, start, sort, defType });
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Solr HTTP ${r.status}: ${txt || r.statusText}`);
  }
  return r.json();
}

function solrEscapeValue(v) {
  // Minimal safe quoting for fq values (handles spaces/special chars)
  // For numeric IDs, it will just quote too—still fine.
  const s = String(v);
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
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

// --- Tool implementations ---
async function tool_solr_search_bool(args) {
  const {
    q = "*:*",
    filter,           // boolean expression object
    fl,
    rows = 10,
    start = 0,
    sort,
    defType,
    extra_fq          // optional: additional fq strings array
  } = args || {};

  const fq = [];
  if (filter) fq.push(compileBoolFilter(filter));
  if (Array.isArray(extra_fq)) fq.push(...extra_fq);

  return solrSelect(SOLR_GENES_CORE, { q, fq: fq.length ? fq : undefined, fl, rows, start, sort, defType });
}
async function tool_solr_search(args) {
  // Genes core
  return solrQuery(SOLR_GENES_CORE, args);
}

async function tool_solr_suggest(args) {
  // Suggestions core
  return solrQuery(SOLR_SUGGESTIONS_CORE, args);
}

async function tool_mongo_list_collections(args) {
  const { nameOnly = true } = args || {};
  const d = await db();

  // returns array of { name, type, options, info... } depending on driver/server
  const items = await d.listCollections({}, { nameOnly: !!nameOnly }).toArray();

  return {
    count: items.length,
    collections: items,
  };
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
  if (typeof filter !== "object" || filter === null) throw new Error("'filter' must be an object");

  const d = await db();
  let cursor = d.collection(collection).find(
    filter,
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

  const d = await db();

  // Your ids are numeric taxonomy IDs, so coerce to numbers safely
  const numIds = ids.map((x) => Number(x)).filter((n) => Number.isFinite(n));

  const docs = await d.collection(collection)
    .find({ _id: { $in: numIds } }, projection ? { projection } : undefined)
    .toArray();

  return { count: docs.length, docs };
}

// --- MCP tool definitions ---
const TOOLS = [
  {
    name: "solr_search",
    description: `Query Solr genes core (${SOLR_GENES_CORE}) via /select.`,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        fq: { type: "array", items: { type: "string" } },
        fl: { type: "string" },
        rows: { type: "integer", minimum: 0, maximum: 1000 },
        start: { type: "integer", minimum: 0 },
        sort: { type: "string" },
        defType: { type: "string" }
      },
      required: ["q"]
    }
  },
  {
    name: "solr_suggest",
    description: `Query Solr suggestions core (${SOLR_SUGGESTIONS_CORE}) via /select.`,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        fq: { type: "array", items: { type: "string" } },
        fl: { type: "string" },
        rows: { type: "integer", minimum: 0, maximum: 1000 },
        start: { type: "integer", minimum: 0 },
        sort: { type: "string" },
        defType: { type: "string" }
      },
      required: ["q"]
    }
  },
  {
    name: "mongo_find",
    description: "Run MongoDB find() on a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        filter: { type: "object" },
        projection: { type: "object" },
        sort: { type: "object" },
        limit: { type: "integer", minimum: 0, maximum: 1000 },
        skip: { type: "integer", minimum: 0 }
      },
      required: ["collection"]
    }
  },
  {
    name: "mongo_list_collections",
    description: "List MongoDB collections in the configured database.",
    inputSchema: {
      type: "object",
      properties: {
        nameOnly: { type: "boolean", description: "If true, return only collection names (default true)." }
      }
    }
  },
  {
    name: "kb_relations",
    description: "Return Solr↔Mongo relationship metadata (field crosswalks).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "mongo_lookup_by_ids",
    description: "Fetch documents by numeric _id from a MongoDB collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        ids: {
          type: "array",
          items: { type: "number" }
        },
        projection: { type: "object" }
      },
      required: ["collection", "ids"]
    }
  },
{
  name: "solr_search_bool",
  description: "Query genes core using a structured boolean filter (AND/OR/NOT) over fq_field/fq_value terms.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string" },
      filter: { type: "object", description: "Boolean expression tree of term/op nodes." },
      extra_fq: { type: "array", items: { type: "string" } },
      fl: { type: "string" },
      rows: { type: "integer", minimum: 0, maximum: 1000 },
      start: { type: "integer", minimum: 0 },
      sort: { type: "string" },
      defType: { type: "string" }
    }
  }
}
];

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
      serverInfo: { name: "minimal-solr-mongo-mcp", version: "0.2.0" }
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

    try {
      let result;
      if (name === "solr_search") result = await tool_solr_search(toolArgs);
      else if (name === "solr_suggest") result = await tool_solr_suggest(toolArgs);
      else if (name === "mongo_find") result = await tool_mongo_find(toolArgs);
      else if (name === "mongo_list_collections") result = await tool_mongo_list_collections(toolArgs);
      else if (name === "kb_relations") result = await tool_kb_relations();
      else if (name === "mongo_lookup_by_ids") result = await tool_mongo_lookup_by_ids(toolArgs);
      else if (name === "solr_search_bool") result = await tool_solr_search_bool(toolArgs);
      else return jsonRpcError(id, -32601, `Unknown tool: ${name}`);

      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });

      return jsonRpcResult(id, {
        content: [{ type: "json", json: result }]
      });
    } catch (e) {
      return jsonRpcError(id, -32000, `Tool error: ${e?.message || String(e)}`);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// --- HTTP server (single MCP endpoint) ---
const server = http.createServer(async (req, res) => {
  try {
    if (!originAllowed(req)) return send(res, 403, null);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/mcp") return send(res, 404, { error: "Not Found:"+ req.headers.host });

    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });

    const msg = await readJson(req);
    const reply = await handleJsonRpc(msg);

    // Notification => 202, empty body
    if (reply === null) return send(res, 202, null);

    return send(res, 200, reply);
  } catch (e) {
    return send(res, 400, jsonRpcError(null, -32700, "Parse error", String(e?.message || e)));
  }
});

server.listen(PORT, HOST, () => {
  console.error(`MCP server listening on http://${HOST}:${PORT}/mcp`);
});

process.on("SIGINT", async () => {
  try {
    await mongoClient.close();
  } finally {
    process.exit(0);
  }
});
