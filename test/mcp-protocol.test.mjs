/**
 * Integration tests for the gramene-mcp server.
 *
 * Two usage modes:
 *
 *   Local seed data (Docker):
 *     docker compose up -d
 *     docker compose exec solr bash /opt/seed/solr-init.sh
 *     MONGO_DB=gramene npm start
 *     npm test
 *
 *   Real data on squam:
 *     npm run start:squam        (in another terminal)
 *     npm test
 *
 * Override the server URL:
 *   MCP_URL=http://127.0.0.1:8787/mcp npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";

// Real identifiers from the squam/sorghum10 dataset.
// Tests that require live data use these.
const REAL = {
  geneTree:  "SB10GT_332720",
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
    assert.equal(res.result.protocolVersion, "2025-11-25");
    assert.equal(res.result.serverInfo.name, "gramene-mcp");
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
      "solr_graph",
      "solr_search",
      "solr_search_bool",
      "solr_suggest",
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
  it("GET /mcp → 405", async () => {
    const res = await fetch(BASE, { method: "GET" });
    assert.equal(res.status, 405);
  });

  it("POST /wrong-path → 404", async () => {
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
    // Solr side
    assert.ok(data.solr?.genes?.fields?.taxonomy__ancestors, "Expected taxonomy__ancestors field");
    assert.ok(data.solr?.genes?.fields?.compara_idx_multi,   "Expected compara_idx_multi field");
    assert.ok(data.solr?.genes?.fields?.["compara_neighbors_*"], "Expected compara_neighbors_* dynamic field");
    assert.ok(data.solr?.genes?.fields?.gene_tree,           "Expected gene_tree field");
    // Mongo side
    assert.ok(data.mongo?.collections?.taxonomy, "Expected taxonomy collection metadata");
  });
});

// ─── MongoDB tools ───────────────────────────────────────────────────

describe("mongo_list_collections", () => {
  it("returns a non-empty list of collections", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_list_collections",
      arguments: { nameOnly: true },
    });
    const data = toolResult(res);
    assert.ok(data.count > 0, "Expected at least one collection");
    assert.ok(Array.isArray(data.collections), "Expected collections array");
    assert.ok(data.collections[0].name, "Each entry should have a name");
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

  it("projection limits returned fields", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", limit: 1, projection: { name: 1, _id: 0 } },
    });
    const data = toolResult(res);
    const doc = data.docs[0];
    assert.ok("name" in doc,  "Expected name field");
    assert.ok(!("_id" in doc), "Expected _id to be excluded");
  });

  it("rejects $where operator", async () => {
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: { collection: "taxonomy", filter: { $where: "true" } },
    });
    // Error can surface as RPC error or as a tool-level error message
    const isError = res.error
      || res.result?.content?.[0]?.text?.includes("not allowed");
    assert.ok(isError, "Expected $where to be rejected");
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
  it("finds suggestions for a gene name using term parameter", async () => {
    const res = await rpc("tools/call", {
      name: "solr_suggest",
      arguments: { term: "msd2", rows: 5 },
    });
    const data = toolResult(res);
    assert.ok(data.responseHeader?.status === 0, "Expected Solr status 0");
    assert.ok(data.response?.numFound > 0, "Expected suggestion results for 'msd2'");
    const doc = data.response.docs[0];
    assert.ok(doc.fq_field, "Expected fq_field on suggestion doc");
    assert.ok(doc.fq_value !== undefined, "Expected fq_value on suggestion doc");
  });

  it("raw q parameter is accepted as fallback", async () => {
    const res = await rpc("tools/call", {
      name: "solr_suggest",
      arguments: { q: "{!boost b=relevance}name:msd2^5 ids:msd2^5 text:msd2*^1", rows: 3 },
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

  it("finds neighbors of a single gene by id", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: {
        from: REAL.graphFrom,
        to:   REAL.graphTo,
        seed_q: `id:${REAL.geneId}`,
        maxDepth: 1,
        fl: "id",
      },
    });
    const data = toolResult(res);
    assert.ok(data.response.numFound > 0, "Expected neighbors for known gene");
    const ids = data.response.docs.map((d) => d.id);
    // With returnRoot=true (default), seed gene should be included
    assert.ok(ids.includes(REAL.geneId), "Expected seed gene in results (returnRoot=true)");
  });

  it("returnRoot=false excludes the seed gene", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: {
        from: REAL.graphFrom,
        to:   REAL.graphTo,
        seed_q: `id:${REAL.geneId}`,
        maxDepth: 1,
        returnRoot: false,
        fl: "id",
      },
    });
    const data = toolResult(res);
    const ids = data.response.docs.map((d) => d.id);
    assert.ok(!ids.includes(REAL.geneId), "Seed gene should be excluded when returnRoot=false");
  });

  it("returns empty for a non-existent seed", async () => {
    const res = await rpc("tools/call", {
      name: "solr_graph",
      arguments: {
        from: REAL.graphFrom,
        to:   REAL.graphTo,
        seed_q: "id:NONEXISTENT_GENE_XYZ_999",
        maxDepth: 1,
      },
    });
    const data = toolResult(res);
    assert.equal(data.response.numFound, 0);
  });

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
  // msd2 (SORBI_3006G095600) is on chr 6, ~46.57 Mb in sorghum bicolor (taxon 4558001)
  const MSD2_REGION = { region: "6", start: 46500000, end: 46650000, taxon_id: 4558001 };

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
    assert.ok(typeof data.gene_count === "number", "Expected gene_count");
    assert.ok(typeof data.experiment_count === "number", "Expected experiment_count");
    assert.ok(data.genes?.[REAL.geneId], `Expected entry for ${REAL.geneId}`);
    const gene = data.genes[REAL.geneId];
    assert.ok(Array.isArray(gene.baseline),     "Expected baseline array");
    assert.ok(Array.isArray(gene.differential), "Expected differential array");
  });

  it("Baseline filter returns only baseline entries", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId], experiment_type: "Baseline" },
    });
    const data = toolResult(res);
    const gene = data.genes?.[REAL.geneId];
    assert.ok(gene, "Expected gene data");
    // With Baseline filter, differential should be empty
    assert.equal(gene.differential.length, 0, "Expected no differential entries under Baseline filter");
  });

  it("Differential filter returns only differential entries", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [REAL.geneId], experiment_type: "Differential" },
    });
    const data = toolResult(res);
    const gene = data.genes?.[REAL.geneId];
    assert.ok(gene, "Expected gene data");
    // With Differential filter, baseline should be empty
    assert.equal(gene.baseline.length, 0, "Expected no baseline entries under Differential filter");
    // Differential entries have l2fc
    if (gene.differential.length > 0) {
      assert.ok(typeof gene.differential[0].l2fc === "number", "Expected l2fc on differential entry");
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
    assert.ok(nSorghum >= 0,     "Expected non-negative sorghum experiment count");
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
  });

  it("non-existent gene returns empty genes map", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: ["FAKE_GENE_DOES_NOT_EXIST_XYZ"] },
    });
    const data = toolResult(res);
    assert.equal(data.gene_count, 0, "Expected zero genes for non-existent ID");
  });

  it("empty gene_ids → tool error", async () => {
    const res = await rpc("tools/call", {
      name: "expression_for_genes",
      arguments: { gene_ids: [] },
    });
    assert.ok(res.error, "Expected error for empty gene_ids");
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

  it("facet limit caps number of values returned", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { field: "system_name", mincount: 1, limit: 3 },
      },
    });
    const pairs = toolResult(res).facet_counts.facet_fields.system_name;
    // limit:3 means at most 3 label/count pairs = at most 6 elements
    assert.ok(pairs.length <= 6, `Expected at most 6 elements with limit:3, got ${pairs.length}`);
  });

  it("PAV workflow — maps in_compara query returns assembly list", async () => {
    // The maps collection should have entries with in_compara boolean
    const res = await rpc("tools/call", {
      name: "mongo_find",
      arguments: {
        collection: "maps",
        filter: { in_compara: true },
        projection: { _id: 1, in_compara: 1 },
        limit: 5,
      },
    });
    const data = toolResult(res);
    assert.ok(data.count > 0,    "Expected at least one in_compara map");
    assert.ok(data.docs.length > 0, "Expected docs in result");
    assert.ok(data.docs[0].in_compara === true, "Expected in_compara:true on each doc");
  });
});

// ─── Facet pivot ─────────────────────────────────────────────────────

describe("solr_search — facet pivot", () => {
  it("pivot on gene_tree,system_name returns facet_pivot structure", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { pivot: "gene_tree,system_name", pivot_mincount: 1 },
      },
    });
    const data = toolResult(res);
    const pivotKey = "gene_tree,system_name";
    assert.ok(data?.facet_counts?.facet_pivot, "Expected facet_counts.facet_pivot");
    assert.ok(Array.isArray(data.facet_counts.facet_pivot[pivotKey]),
      `Expected facet_pivot["${pivotKey}"] to be an array`);
  });

  it("pivot entries have value, count, and nested pivot array", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { pivot: "gene_tree,system_name", pivot_mincount: 1 },
      },
    });
    const entries = toolResult(res).facet_counts.facet_pivot["gene_tree,system_name"];
    assert.ok(entries.length > 0, "Expected at least one gene_tree pivot entry");
    const first = entries[0];
    assert.equal(first.field, "gene_tree",       "Expected field='gene_tree' on top-level entry");
    assert.equal(typeof first.value, "string",   "Expected string value (tree ID)");
    assert.equal(typeof first.count, "number",   "Expected numeric count");
    assert.ok(Array.isArray(first.pivot),        "Expected nested pivot array");
    assert.ok(first.pivot.length > 0,            "Expected at least one system_name in nested pivot");
    assert.equal(first.pivot[0].field, "system_name", "Expected field='system_name' on nested entry");
    assert.equal(typeof first.pivot[0].count, "number", "Expected numeric count on nested entry");
  });

  it("graph traversal + pivot — neighborhood CNV single query", async () => {
    // The key CNV workflow: {!graph} expands to neighborhood, pivot counts per genome
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `{!graph from=compara_neighbors_10 to=compara_idx_multi}gene_tree:${REAL.geneTree}`,
        fq: ["taxonomy__ancestors:4558"],
        rows: 0,
        facet: { pivot: "gene_tree,system_name", pivot_mincount: 1 },
      },
    });
    const data = toolResult(res);
    assert.ok(data.response.numFound > 0, "Expected genes found via graph traversal");
    const pivotEntries = data.facet_counts?.facet_pivot?.["gene_tree,system_name"];
    assert.ok(Array.isArray(pivotEntries) && pivotEntries.length > 0,
      "Expected pivot entries from graph+pivot query");
    // Should cover multiple gene families (neighbors) and multiple genomes
    const totalGenomesAcrossAll = pivotEntries.reduce((s, e) => s + (e.pivot?.length ?? 0), 0);
    assert.ok(totalGenomesAcrossAll > 1, "Expected multiple genome entries across gene families");
  });

  it("pivot_mincount=1 excludes absent genomes from pivot results", async () => {
    const res = await rpc("tools/call", {
      name: "solr_search",
      arguments: {
        q: `gene_tree:${REAL.geneTree}`,
        rows: 0,
        facet: { pivot: "gene_tree,system_name", pivot_mincount: 1 },
      },
    });
    const entries = toolResult(res).facet_counts.facet_pivot["gene_tree,system_name"];
    // With pivot_mincount=1, every nested entry must have count >= 1
    for (const entry of entries) {
      for (const nested of (entry.pivot || [])) {
        assert.ok(nested.count >= 1,
          `Expected count >= 1 with pivot_mincount=1, got ${nested.count} for ${nested.value}`);
      }
    }
  });
});
