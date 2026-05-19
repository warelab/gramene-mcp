/**
 * Integration tests for the gramene-mcp server.
 *
 * Usage:
 *   npm start              (in one terminal)
 *   npm test               (in another)
 *
 * Override the server URL:
 *   MCP_URL=http://127.0.0.1:8787/mcp npm test
 *
 * The tests assume the server is configured to talk to data.gramene.org/v69
 * (the default). Some assertions reference identifiers known to be present in
 * that release.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";

// Identifiers known to exist in the data.gramene.org/v69 release.
const REAL = {
  geneTree:  "EPlGT00940000164729",
  geneId:    "SORBI_3006G095600",
  graphFrom: "compara_neighbors_10",
  graphTo:   "compara_idx_multi",
};

let nextId = 1;

async function rpc(method, params = {}) {
  const id = nextId++;
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(res.status, 200, `HTTP ${res.status} for ${method}`);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  return body;
}

function toolResult(body) {
  assert.ok(!body.error, `RPC error: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text;
  assert.ok(text, "Expected text content in result");
  return JSON.parse(text);
}

// ─── Protocol ────────────────────────────────────────────────────────

describe("MCP protocol", () => {
  it("initialize", async () => {
    const res = await rpc("initialize");
    assert.ok(!res.error);
    // Server picks the first supported protocol version on initialize.
    assert.ok(res.result.protocolVersion, "Expected protocolVersion in initialize result");
    assert.equal(res.result.serverInfo.name, "gramene-mcp");
    // Capabilities advertise both tools and prompts.
    assert.ok(res.result.capabilities?.tools, "Expected tools capability");
    assert.ok(res.result.capabilities?.prompts, "Expected prompts capability");
  });

  it("ping", async () => {
    const res = await rpc("ping");
    assert.ok(!res.error);
  });

  it("tools/list returns all tools", async () => {
    const res = await rpc("tools/list");
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "expression_for_genes",
      "genes_in_region",
      "kb_relations",
      "mongo_find",
      "mongo_list_collections",
      "mongo_lookup_by_ids",
      "pubmed_for_genes",
      "solr_graph",
      "solr_search",
      "solr_search_bool",
      "solr_suggest",
      "vep_for_gene",
    ]);
  });

  it("unknown method → -32601 error", async () => {
    const res = await rpc("bogus/method");
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
  });

  it("unknown tool → -32601 error", async () => {
    const res = await rpc("tools/call", { name: "nonexistent", arguments: {} });
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
  });
});

// ─── HTTP edge cases ─────────────────────────────────────────────────

describe("HTTP edge cases", () => {
  it("GET /mcp → discovery document", async () => {
    const res = await fetch(BASE, { method: "GET" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const doc = await res.json();
    assert.equal(doc.status, "ok");
    assert.equal(doc.server?.name, "gramene-mcp");
    assert.ok(doc.server?.version, "Expected server.version");
    assert.equal(doc.server?.transport, "http");
    assert.ok(Array.isArray(doc.protocolVersions) && doc.protocolVersions.length > 0,
      "Expected at least one supported protocolVersion");
    assert.equal(typeof doc.capabilities?.tools, "boolean");
    assert.equal(typeof doc.capabilities?.prompts, "boolean");
    assert.equal(doc.auth?.mode, "none");
  });

  it("POST /wrong-path → 404", async () => {
    // 405 ("Method Not Allowed") implies the resource exists but doesn't accept
    // the method. An unknown path correctly returns 404 ("Not Found").
    const url = BASE.replace("/mcp", "/wrong");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });

  it("empty body → 400", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    assert.equal(res.status, 400);
  });
});

// ─── kb_relations ────────────────────────────────────────────────────

describe("kb_relations", () => {
  it("returns relationship metadata with expected structure", async () => {
    const res = await rpc("tools/call", { name: "kb_relations", arguments: {} });
    const data = toolResult(res);
    // search-index side
    assert.ok(data.search_index?.genes?.fields?.taxonomy__ancestors, "Expected taxonomy__ancestors field");
    assert.ok(data.search_index?.genes?.fields?.compara_idx_multi,   "Expected compara_idx_multi field");
    assert.ok(data.search_index?.genes?.fields?.["compara_neighbors_*"], "Expected compara_neighbors_* dynamic field");
    assert.ok(data.search_index?.genes?.fields?.gene_tree,           "Expected gene_tree field");
    // collections side
    assert.ok(data.collections?.taxonomy, "Expected taxonomy collection metadata");
  });
});

// ─── MongoDB tools ───────────────────────────────────────────────────

describe("mongo_list_collections", () => {
  it("returns the fixed set of API-served collections", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_list_collections",
      arguments: { nameOnly: true },
    });
    const data = toolResult(res);
    assert.ok(data.count > 0, "Expected at least one collection");
    assert.ok(Array.isArray(data.collections), "Expected collections array");
    const names = data.collections.map((c) => c.name);
    assert.ok(names.includes("taxonomy"), "Expected taxonomy collection in list");
    assert.ok(names.includes("genes"),    "Expected genes collection in list");
  });
});

describe("mongo_find", () => {
  it("returns documents with expected shape from taxonomy", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", limit: 3 },
    });
    const data = toolResult(res);
    assert.ok(data.count > 0, "Expected taxonomy documents");
    const doc = data.docs[0];
    assert.ok("_id" in doc, "Expected _id field");
    assert.ok("name" in doc, "Expected name field");
  });

  it("filter by known NCBI taxonomy ID returns the right species", async () => {
    // 3702 = Arabidopsis thaliana in NCBI taxonomy — present in any Gramene dataset
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", filter: { _id: 3702 } },
    });
    const data = toolResult(res);
    assert.equal(data.count, 1);
    assert.match(data.docs[0].name, /arabidopsis/i);
  });

  it("$in filter on _id batches multiple IDs", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", filter: { _id: { $in: [3702, 4577] } } },
    });
    const data = toolResult(res);
    assert.equal(data.count, 2);
    const names = data.docs.map((d) => d.name.toLowerCase()).join("|");
    assert.match(names, /arabidopsis/);
    assert.match(names, /zea/);
  });

  it("projection (inclusion) limits returned fields", async () => {
    // The API's `fl` always omits _id when an inclusion list is set.
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", limit: 1, projection: { name: 1 } },
    });
    const data = toolResult(res);
    const doc = data.docs[0];
    assert.ok("name" in doc, "Expected name field");
    assert.ok(!("_id" in doc), "Expected _id to be excluded by the API's fl behavior");
  });

  it("rejects $where operator", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", filter: { $where: "true" } },
    });
    const isError = res.error
      || res.result?.content?.[0]?.text?.includes("not supported");
    assert.ok(isError, "Expected $where to be rejected");
  });

  it("rejects $gt/$lt operators that the public API can't express", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", filter: { _id: { $gt: 3000 } } },
    });
    const isError = res.error
      || res.result?.content?.[0]?.text?.includes("not supported");
    assert.ok(isError, "Expected $gt to be rejected");
  });
});

describe("mongo_lookup_by_ids", () => {
  it("fetches known taxonomy entries by numeric _id", async () => {
    // 3702 = A. thaliana, 4577 = Zea mays — real NCBI IDs present in Gramene
    const res = await rpc("tools/call", {
      name: "mongo_lookup_by_ids",
      arguments: { collection: "taxonomy", ids: [3702, 4577] },
    });
    const data = toolResult(res);
    assert.equal(data.count, 2, "Expected both IDs to be found");
    const names = data.docs.map((d) => d.name);
    assert.ok(names.some((n) => /arabidopsis/i.test(n)), "Expected Arabidopsis");
    assert.ok(names.some((n) => /zea/i.test(n)), "Expected Zea mays");
  });

  it("returns empty for non-existent IDs", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_lookup_by_ids",
      arguments: { collection: "taxonomy", ids: [999999999] },
    });
    const data = toolResult(res);
    assert.equal(data.count, 0);
  });
});

// ─── Solr tools ──────────────────────────────────────────────────────

describe("solr_search", () => {
  it("returns a valid Solr response envelope", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: { q: "*:*", rows: 3, fl: "id" },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
    assert.ok(typeof data.response?.numFound === "number", "Expected numFound");
    assert.ok(data.response.numFound > 0, "Expected genes in index");
    assert.ok(Array.isArray(data.response.docs), "Expected docs array");
  });

  it("fq reduces result count compared to unfiltered", async () => {
    const [all, filtered] = await Promise.all([
      rpc("tools/call", { name: "solr_search", arguments: { q: "*:*", rows: 0 } }),
      rpc("tools/call", { name: "solr_search", arguments: { q: "*:*", rows: 0, fq: ["taxonomy__ancestors:3702"] } }),
    ]);
    const total    = toolResult(all).response.numFound;
    const athaliana = toolResult(filtered).response.numFound;
    assert.ok(total > 0,           "Expected genes in index");
    assert.ok(athaliana > 0,       "Expected Arabidopsis genes");
    assert.ok(athaliana < total,   "Filter should reduce result count");
  });

  it("missing q → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: { rows: 5 },
    });
    assert.ok(res.error, "Expected error when q is missing");
  });
});

describe("solr_suggest", () => {
  it("finds suggestions for a gene-family name using the term parameter", async () => {
    const res = await rpc("tools/call", {
      name: "solr_suggest",
      arguments: { term: "lipoxygenase", rows: 5 },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
    // Response is the grouped envelope: grouped.category.{matches, groups[]}.
    assert.ok(data.grouped?.category, "Expected grouped.category envelope");
    assert.ok(data.grouped.category.matches > 0, "Expected matches > 0 for 'lipoxygenase'");
    const firstDoc = data.grouped.category.groups[0]?.doclist?.docs?.[0];
    assert.ok(firstDoc, "Expected at least one suggestion doc");
    assert.ok(firstDoc.fq_field, "Expected fq_field on suggestion doc");
    assert.ok(firstDoc.fq_value !== undefined, "Expected fq_value on suggestion doc");
  });

  it("raw q parameter is accepted as fallback (field-qualified query)", async () => {
    const res = await rpc("tools/call", {
      name: "solr_suggest",
      arguments: { q: 'name:"Sorghum bicolor"', rows: 3 },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
  });

  it("missing both term and q → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "solr_suggest",
      arguments: { rows: 5 },
    });
    assert.ok(res.error, "Expected error when neither term nor q is provided");
  });
});

describe("solr_search_bool", () => {
  it("with no filter returns all genes", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search_bool",
      arguments: { rows: 0 },
    });
    const data = toolResult(res);
    assert.ok(data.response.numFound > 0, "Expected results with no filter");
  });

  it("single term filter works", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search_bool",
      arguments: {
        filter: { term: { field: "taxonomy__ancestors", value: 3702 } },
        rows: 0,
      },
    });
    const data = toolResult(res);
    assert.ok(data.response.numFound > 0, "Expected Arabidopsis genes");
  });

  it("AND filter is more restrictive than either term alone", async () => {
    const [r1, r2, rAnd] = await Promise.all([
      rpc("tools/call", { name: "solr_search_bool", arguments: { filter: { term: { field: "taxonomy__ancestors", value: 3702 } }, rows: 0 } }),
      rpc("tools/call", { name: "solr_search_bool", arguments: { filter: { term: { field: "GO__ancestors", value: 5488 } }, rows: 0 } }),
      rpc("tools/call", { name: "solr_search_bool", arguments: {
        filter: { op: "AND", args: [
          { term: { field: "taxonomy__ancestors", value: 3702 } },
          { term: { field: "GO__ancestors", value: 5488 } },
        ]},
        rows: 0,
      }}),
    ]);
    const n1   = toolResult(r1).response.numFound;
    const n2   = toolResult(r2).response.numFound;
    const nAnd = toolResult(rAnd).response.numFound;
    assert.ok(nAnd <= n1, "AND result should be <= first term alone");
    assert.ok(nAnd <= n2, "AND result should be <= second term alone");
  });
});

// ─── solr_graph ──────────────────────────────────────────────────────

describe("solr_graph", () => {
  it("returns a valid Solr response envelope", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: {
        from: REAL.graphFrom,
        to:   REAL.graphTo,
        seed_q: `gene_tree:${REAL.geneTree}`,
        maxDepth: 1,
        rows: 5,
        fl: "id",
      },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
    assert.ok(typeof data.response?.numFound === "number", "Expected numFound");
  });

  it("finds genomic neighbors of a gene tree", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: {
        from: REAL.graphFrom,
        to:   REAL.graphTo,
        seed_q: `gene_tree:${REAL.geneTree}`,
        maxDepth: 1,
        rows: 50,
        fl: "id,gene_id",
      },
    });
    const data = toolResult(res);
    assert.ok(data.response.numFound > 0, "Expected neighbor genes");
    assert.ok(Array.isArray(data.response.docs), "Expected docs array");
  });

  // The public API's default /search parser does not always honor `id:` seeds
  // inside a {!graph} local-params clause — fielded queries on single ids are
  // tokenised differently than in raw Solr. The graph-by-gene_tree path
  // (tested above) is the reliable shape on this backend.

  it("missing required fields → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: { from: REAL.graphFrom }, // missing 'to' and 'seed_q'
    });
    assert.ok(res.error, "Expected RPC error for missing required fields");
    assert.ok(res.error.message.includes("requires"), `Got: ${res.error.message}`);
  });
});

// ─── genes_in_region ─────────────────────────────────────────────────

describe("genes_in_region", () => {
  // msd2 (SORBI_3006G095600) is on chr 6, ~46.57 Mb in sorghum bicolor (taxon 4558)
  const MSD2_REGION = { region: "6", start: 46500000, end: 46650000, taxon_id: 4558 };

  it("returns a valid Solr response envelope", async () => {
    const res = await rpc("tools/call", {
      name: "genes_in_region",
      arguments: { ...MSD2_REGION, fl: "id,name,start,end", rows: 5 },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
    assert.ok(typeof data.response?.numFound === "number", "Expected numFound");
    assert.ok(Array.isArray(data.response.docs), "Expected docs array");
  });

  it("finds the known msd2 gene within its own region", async () => {
    const res = await rpc("tools/call", {
      name: "genes_in_region",
      arguments: { ...MSD2_REGION, fl: "id", rows: 100 },
    });
    const data = toolResult(res);
    const ids = data.response.docs.map((d) => d.id);
    assert.ok(ids.includes(REAL.geneId), `Expected ${REAL.geneId} in region results`);
  });

  it("returns fewer genes when taxon_id narrows to sorghum only", async () => {
    const [all, sorghum] = await Promise.all([
      rpc("tools/call", { name: "genes_in_region", arguments: { region: MSD2_REGION.region, start: MSD2_REGION.start, end: MSD2_REGION.end, rows: 0 } }),
      rpc("tools/call", { name: "genes_in_region", arguments: { ...MSD2_REGION, rows: 0 } }),
    ]);
    const nAll     = toolResult(all).response.numFound;
    const nSorghum = toolResult(sorghum).response.numFound;
    assert.ok(nAll > 0,           "Expected genes without taxon filter");
    assert.ok(nSorghum > 0,       "Expected sorghum genes in region");
    assert.ok(nSorghum <= nAll,   "Taxon filter should not increase count");
  });

  it("returns empty for a non-existent region", async () => {
    const res = await rpc("tools/call", {
      name: "genes_in_region",
      arguments: { region: "99", start: 1, end: 1000 },
    });
    const data = toolResult(res);
    assert.equal(data.response.numFound, 0);
  });

  it("missing required fields → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "genes_in_region",
      arguments: { region: "6" }, // missing start and end
    });
    assert.ok(res.error, "Expected error for missing start/end");
  });
});

// ─── expression_for_genes ────────────────────────────────────────────

describe("expression_for_genes", () => {
  it("returns expression data for a known sorghum gene", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const data = toolResult(res);
    assert.equal(data.gene_count, 1, "Expected gene_count to reflect requested gene_ids");
    assert.ok(typeof data.experiment_count === "number", "Expected experiment_count");
    const gene = data.genes?.[REAL.geneId];
    assert.ok(gene, `Expected entry for ${REAL.geneId}`);
    assert.ok(Array.isArray(gene.baseline),               "Expected baseline array");
    assert.ok(Array.isArray(gene.differential),           "Expected differential array");
    assert.ok(Array.isArray(gene.experiments_with_data),  "Expected experiments_with_data array");
    assert.ok(gene.experiments_with_data.length > 0,      "Sorghum gene should have at least one expression experiment");
    assert.ok(gene.baseline.length + gene.differential.length > 0, "Sorghum gene should have expression rows");
  });

  it("baseline rows expose value, tissue, and factors", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId], experiment_type: "Baseline" },
    });
    const data = toolResult(res);
    const gene = data.genes?.[REAL.geneId];
    assert.ok(gene, "Expected gene data");
    assert.equal(gene.differential.length, 0, "Expected no differential entries under Baseline filter");
    assert.ok(gene.baseline.length > 0, "Expected at least one baseline row");
    const row = gene.baseline[0];
    assert.equal(typeof row.value, "number", "baseline value should be numeric");
    assert.ok(typeof row.experiment === "string" && row.experiment.startsWith("E-"), "experiment id should be reconstructed with dashes");
    assert.ok(/^g\d+$/.test(row.group), "group should be 'gN'");
    assert.ok("tissue" in row,  "row should expose tissue");
    assert.ok(Array.isArray(row.factors), "row should expose factors[]");
  });

  it("differential rows expose contrast structure with control + treatment factors", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId], experiment_type: "Differential" },
    });
    const data = toolResult(res);
    const gene = data.genes?.[REAL.geneId];
    assert.ok(gene, "Expected gene data");
    assert.equal(gene.baseline.length, 0, "Expected no baseline entries under Differential filter");
    if (gene.differential.length === 0) return; // nothing to assert if no DE rows
    const row = gene.differential[0];
    assert.ok(typeof row.l2fc === "number", "l2fc should be numeric");
    assert.ok(/^g\d+$/.test(row.control_group),   "control_group should be 'gN'");
    assert.ok(/^g\d+$/.test(row.treatment_group), "treatment_group should be 'gN'");
    assert.ok(Array.isArray(row.control_factors),   "control_factors should be an array");
    assert.ok(Array.isArray(row.treatment_factors), "treatment_factors should be an array");
    assert.ok(Array.isArray(row.contrast),          "contrast should be an array");
    assert.ok(Array.isArray(row.shared_factors),    "shared_factors should be an array");
    for (const c of row.contrast) {
      assert.ok("type" in c && "control" in c && "treatment" in c, "contrast entry should have type/control/treatment");
    }
  });

  it("taxon_id filter reduces experiment count", async () => {
    const [all, sorghum] = await Promise.all([
      rpc("tools/call", { name: "expression_for_genes", arguments: { gene_ids: [REAL.geneId] } }),
      rpc("tools/call", { name: "expression_for_genes", arguments: { gene_ids: [REAL.geneId], taxon_id: 4558 } }),
    ]);
    const nAll    = toolResult(all).experiment_count;
    const nSorghum = toolResult(sorghum).experiment_count;
    assert.ok(nAll > 0,          "Expected experiments without filter");
    assert.ok(nSorghum > 0,      "Expected sorghum experiments");
    assert.ok(nSorghum <= nAll,  "Taxon filter should not increase experiment count");
  });

  it("po_terms filter restricts to tissue-matched assays", async () => {
    // PO:0009001 (int_id 9001) = fruit/grain
    const [all, grain] = await Promise.all([
      rpc("tools/call", { name: "expression_for_genes", arguments: { gene_ids: [REAL.geneId], experiment_type: "Baseline" } }),
      rpc("tools/call", { name: "expression_for_genes", arguments: { gene_ids: [REAL.geneId], experiment_type: "Baseline", po_terms: [9001] } }),
    ]);
    const allBaseline   = toolResult(all).genes?.[REAL.geneId]?.baseline ?? [];
    const grainBaseline = toolResult(grain).genes?.[REAL.geneId]?.baseline ?? [];
    assert.ok(grainBaseline.length <= allBaseline.length, "PO filter should not increase baseline entries");
    const grainData = toolResult(grain);
    assert.ok(grainData.po_filter, "PO filter response should include po_filter metadata");
    assert.deepEqual(grainData.po_filter.requested, [9001]);
  });

  it("po ancestor fallback flips po_filter.expanded when only ancestors match", async () => {
    // PO:0005360 (aleurone layer) — too specific for direct assay annotations,
    // but its ancestors include endosperm (9089) which does match.
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId], experiment_type: "Baseline", po_terms: [5360] },
    });
    const data = toolResult(res);
    assert.ok(data.po_filter, "Expected po_filter metadata");
    assert.deepEqual(data.po_filter.requested, [5360]);
    if ((data.genes[REAL.geneId]?.baseline?.length ?? 0) > 0) {
      assert.equal(data.po_filter.expanded, true, "Expected expanded:true when only ancestors matched");
      assert.ok(data.po_filter.ancestors_used.length > 0, "Expected ancestors_used to be non-empty");
    }
  });

  it("non-existent gene returns an empty entry, not a missing one", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: ["FAKE_GENE_DOES_NOT_EXIST_XYZ"] },
    });
    const data = toolResult(res);
    assert.equal(data.gene_count, 1, "gene_count counts requested ids, not Solr matches");
    const gene = data.genes["FAKE_GENE_DOES_NOT_EXIST_XYZ"];
    assert.ok(gene, "Expected an entry even for a non-existent gene");
    assert.equal(gene.baseline.length, 0);
    assert.equal(gene.differential.length, 0);
    assert.deepEqual(gene.experiments_with_data, []);
  });

  it("empty gene_ids → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [] },
    });
    assert.ok(res.error || res.result?.isError, "Expected error for empty gene_ids");
  });
});

// ─── Facet counting ───────────────────────────────────────────────────

describe("solr_search — facets", () => {
  it("facet on system_name returns facet_counts", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { field: "system_name", mincount: 1, limit: -1 },
      },
    });
    const data = toolResult(res);
    const facetFields = data?.facet_counts?.facet_fields;
    assert.ok(facetFields, "Expected facet_counts.facet_fields in response");
    assert.ok(Array.isArray(facetFields.system_name), "Expected system_name facet array");
    assert.ok(facetFields.system_name.length > 0, "Expected at least one facet value");
  });

  it("facet counts alternate between label and count", async () => {
    // Solr returns facets as a flat [label, count, label, count, ...] array
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { field: "system_name", mincount: 1, limit: -1 },
      },
    });
    const pairs = toolResult(res).facet_counts.facet_fields.system_name;
    // Even indices should be strings (genome names), odd indices should be numbers (counts)
    for (let i = 0; i < Math.min(pairs.length, 10); i++) {
      if (i % 2 === 0) assert.equal(typeof pairs[i], "string", `Expected string at index ${i}`);
      else             assert.equal(typeof pairs[i], "number", `Expected number at index ${i}`);
    }
  });

  it("rows:0 with facet returns no docs but has facet_counts", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        fl: "id",
        facet: { field: "system_name", mincount: 1, limit: 5 },
      },
    });
    const data = toolResult(res);
    assert.equal(data.response.docs.length, 0, "Expected 0 docs with rows:0");
    assert.ok(data.response.numFound > 0,    "Expected numFound > 0");
    assert.ok(data.facet_counts,             "Expected facet_counts present");
  });

  // Note: the public Gramene API doesn't honor facet.limit / facet.mincount /
  // facet.pivot / facet.range — only `facet.field` (and `json.facet` for nested
  // counts) pass through. The convenience options on the tool are no-ops here.

  it("PAV workflow — maps idList lookup returns the requested assembly", async () => {
    // The public API doesn't support filtering by boolean fields. Use idList
    // to fetch a known map document directly.
    const res = await rpc("tools/call", {
      name: "mongo_lookup_by_ids",
      arguments: { collection: "maps", ids: ["GCA_000003195.3"] },
    });
    const data = toolResult(res);
    assert.equal(data.count, 1, "Expected the requested map doc");
    assert.equal(data.docs[0]._id, "GCA_000003195.3");
    assert.equal(data.docs[0].system_name, "sorghum_bicolor");
  });
});

// Nested faceting via facet.pivot is not exposed by the public Gramene REST API.
// For nested counts, build a `json.facet` clause and pass it through solr_search.
// (No automated tests cover that here — verify by hand against your dataset.)

// ─── vep_for_gene ─────────────────────────────────────────────────────

describe("vep_for_gene — tool registration", () => {
  it("vep_for_gene appears in tools/list", async () => {
    const res = await rpc("tools/list");
    const tools = res.result?.tools ?? [];
    const vepTool = tools.find((t) => t.name === "vep_for_gene");
    assert.ok(vepTool, "Expected vep_for_gene in tools/list");
    assert.ok(typeof vepTool.description === "string" && vepTool.description.length > 10,
      "Expected non-empty description");
  });

  it("vep_for_gene requires gene_ids param", async () => {
    const res = await rpc("tools/call", { name: "vep_for_gene", arguments: {} });
    // Should return an error (either tool-level or JSON-RPC)
    const hasError = res.error != null
      || res.result?.content?.[0]?.text?.includes("requires")
      || res.result?.isError === true;
    assert.ok(hasError, "Expected an error when gene_ids is missing");
  });
});

describe("vep_for_gene — shape", () => {
  it("returns the expected envelope for any queried gene", async () => {
    // VEP data presence is species-specific (sorghum, maize, several rice
    // genomes). The all-plants release on data.gramene.org may not carry VEP
    // annotations for any single gene in this dataset, so we only check the
    // structural envelope here. Run the test suite against a species-focused
    // stack to exercise the LOF assertions.
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const data = toolResult(res);
    assert.ok(data, "Expected a result");
    assert.equal(data.gene_count, 1, "Expected gene_count to match request");
    const gene = data.genes[REAL.geneId];
    assert.ok(gene, `Expected entry for ${REAL.geneId}`);
    assert.ok(gene.summary, "Expected summary object");
    assert.ok(Array.isArray(gene.groups), "Expected groups array");
  });
});
// ─── pubmed_for_genes ────────────────────────────────────────────────

describe("pubmed_for_genes", () => {
  it("is registered", async () => {
    const res = await rpc("tools/list");
    const names = res.result.tools.map((t) => t.name);
    assert.ok(names.includes("pubmed_for_genes"), "pubmed_for_genes should be registered");
  });

  it("requires gene_ids", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: {},
    });
    assert.ok(res.error || res.result?.isError, "Should error when gene_ids missing");
  });

  it("returns PMID xrefs for a gene with known publications", async () => {
    // SORBI_3006G095600 has PUBMED__xrefs: ["31597271"] (Gladman et al. 2019)
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3006G095600"] },
    });
    const data = toolResult(res);
    assert.ok(data.gene_count >= 1, "Should find the gene");
    assert.ok(data.genes_with_refs >= 1, "Gene should have references");
    const gene = data.genes["SORBI_3006G095600"];
    assert.ok(gene, "Gene entry should exist");
    assert.ok(gene.count >= 1, "Should have at least 1 reference");
    assert.ok(Array.isArray(gene.pmids), "pmids should be an array");
    assert.ok(Array.isArray(gene.dois), "dois should be an array");
    assert.ok(gene.pmids.length + gene.dois.length === gene.count, "count should equal pmids + dois");
    assert.ok(gene.pmids.every((p) => /^\d+$/.test(p)), "pmids should be numeric strings");
    assert.ok(gene.dois.every((d) => !d.startsWith("DOI:")), "dois should be stripped of the 'DOI:' prefix");
  });

  it("returns empty references for a gene without publications", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3001G000100"] },
    });
    const data = toolResult(res);
    const gene = data.genes["SORBI_3001G000100"];
    assert.ok(gene, "Gene entry should exist even without references");
    assert.equal(gene.count, 0, "Should have 0 references");
    assert.deepEqual(gene.pmids, []);
    assert.deepEqual(gene.dois, []);
  });

  it("handles multiple genes in a single call", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: {
        gene_ids: ["SORBI_3006G095600", "SORBI_3009G083300"],
      },
    });
    const data = toolResult(res);
    assert.equal(Object.keys(data.genes).length, 2, "Should return entries for both genes");
    assert.ok(data.total_unique_pmids + data.total_unique_dois >= 1, "Should have at least 1 reference total");
  });

  it("handles rice genes with DOI references", async () => {
    // Os01g0102400 has both PMID and DOI refs
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["Os01g0102400"] },
    });
    const data = toolResult(res);
    const gene = data.genes["Os01g0102400"];
    assert.ok(gene, "Rice gene entry should exist");
    assert.ok(gene.count >= 1, "Should have at least 1 reference");
  });
});

// ─── Prompts ─────────────────────────────────────────────────────────

describe("prompts/list", () => {
  it("returns the full set of workflow prompts", async () => {
    const res = await rpc("prompts/list");
    assert.ok(!res.error);
    const names = res.result.prompts.map((p) => p.name).sort();
    assert.deepEqual(names, [
      "base",
      "cross_species_comparison",
      "gene_family",
      "gene_family_expansion",
      "gene_lookup",
      "germplasm_lof",
      "literature_search",
      "orthologs_paralogs",
      "pathway_genes",
      "pav_cnv",
      "qtl_candidate_ranking",
      "qtl_discovery",
    ]);
  });

  it("each prompt has name, title, description, and arguments", async () => {
    const res = await rpc("prompts/list");
    for (const p of res.result.prompts) {
      assert.ok(p.name, "prompt.name required");
      assert.ok(p.title, `prompt.title required (${p.name})`);
      assert.ok(p.description, `prompt.description required (${p.name})`);
      assert.ok(Array.isArray(p.arguments), `prompt.arguments must be array (${p.name})`);
    }
  });
});

describe("prompts/get", () => {
  it("returns the base prompt with a user message", async () => {
    const res = await rpc("prompts/get", { name: "base" });
    assert.ok(!res.error);
    assert.ok(res.result.description, "Expected description");
    assert.ok(Array.isArray(res.result.messages), "Expected messages array");
    assert.equal(res.result.messages.length, 1);
    const msg = res.result.messages[0];
    assert.equal(msg.role, "user");
    assert.equal(msg.content.type, "text");
    assert.ok(msg.content.text.includes("Gramene MCP Agent"), "Expected base prompt header");
    assert.ok(msg.content.text.includes("Critical Conventions"), "Expected conventions section");
  });

  it("interpolates required arguments into a workflow prompt", async () => {
    const res = await rpc("prompts/get", {
      name: "gene_lookup",
      arguments: { query: "lipoxygenase", species: "Sorghum bicolor" },
    });
    assert.ok(!res.error);
    const text = res.result.messages[0].content.text;
    assert.ok(text.includes("lipoxygenase"), "Expected 'query' interpolation");
    assert.ok(text.includes("Sorghum bicolor"), "Expected 'species' interpolation");
    // Placeholders should have been substituted — no leftover {{...}} markers.
    assert.ok(!/\{\{[a-z_]+\}\}/.test(text), "Expected no unresolved placeholders");
  });

  it("leaves optional arguments empty when not supplied", async () => {
    const res = await rpc("prompts/get", {
      name: "gene_lookup",
      arguments: { query: "drought tolerance" },
    });
    assert.ok(!res.error);
    const text = res.result.messages[0].content.text;
    assert.ok(text.includes("drought tolerance"));
    assert.ok(!/\{\{[a-z_]+\}\}/.test(text), "Expected no unresolved placeholders");
  });

  it("rejects an unknown prompt with -32602", async () => {
    const res = await rpc("prompts/get", { name: "nonexistent_workflow" });
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
  });

  it("rejects missing required arguments with -32602", async () => {
    // gene_lookup requires a 'query' argument.
    const res = await rpc("prompts/get", { name: "gene_lookup", arguments: {} });
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
    assert.ok(/query/i.test(res.error.message), "Error message should name the missing arg");
  });

  it("qtl_candidate_ranking interpolates region + coordinates", async () => {
    const res = await rpc("prompts/get", {
      name: "qtl_candidate_ranking",
      arguments: {
        region: "6",
        start: 52000000,
        end: 58000000,
        taxon_id: 4558,
      },
    });
    assert.ok(!res.error);
    const text = res.result.messages[0].content.text;
    assert.ok(text.includes('"6"'), "Expected region value");
    assert.ok(text.includes("52000000"), "Expected start coordinate");
    assert.ok(text.includes("4558"), "Expected taxon_id");
  });

  it("advertises arguments for every workflow that takes them", async () => {
    const list = await rpc("prompts/list");
    const withArgs = list.result.prompts.filter((p) => (p.arguments || []).length > 0);
    assert.ok(withArgs.length >= 8, "Expected most workflows to accept arguments");
    // Each declared argument must have a name and description.
    for (const p of withArgs) {
      for (const a of p.arguments) {
        assert.ok(a.name, `arg.name required (${p.name})`);
        assert.ok(a.description, `arg.description required (${p.name}.${a.name})`);
      }
    }
  });
});
