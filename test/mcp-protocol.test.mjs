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
      "enrichment_analysis",
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
  it("GET /mcp → 405", async () => {
    const res = await fetch(BASE, { method: "GET" });
    assert.equal(res.status, 405);
  });

  it("POST /wrong-path → 405", async () => {
    const url = BASE.replace("/mcp", "/wrong");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 405);
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

describe("vep_for_gene — live data (SORBI_3006G095600)", () => {
  it("returns a result object with expected structure", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const data = toolResult(res);
    assert.ok(data, "Expected a result");
    assert.ok(data.gene_count >= 1, "Expected gene_count >= 1");
    assert.ok(data.genes, "Expected genes object in result");
    assert.ok(data.genes[REAL.geneId], `Expected entry for ${REAL.geneId}`);
  });

  it("summary has total_lof_accessions > 0 for a known LOF gene", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const summary = toolResult(res).genes[REAL.geneId].summary;
    assert.ok(typeof summary.total_lof_accessions === "number",
      "Expected numeric total_lof_accessions");
    assert.ok(summary.total_lof_accessions > 0,
      `Expected > 0 LOF accessions for ${REAL.geneId}`);
  });

  it("summary includes separate ems_accessions and nat_accessions counts", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const summary = toolResult(res).genes[REAL.geneId].summary;
    assert.ok(typeof summary.ems_accessions === "number", "Expected numeric ems_accessions");
    assert.ok(typeof summary.nat_accessions === "number", "Expected numeric nat_accessions");
  });

  it("groups array has expected shape (consequence, zygosity, study_label, accessions)", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const gene = toolResult(res).genes[REAL.geneId];
    assert.ok(Array.isArray(gene.groups), "Expected groups array");
    assert.ok(gene.groups.length > 0, "Expected at least one group");
    const g = gene.groups[0];
    assert.ok(typeof g.consequence === "string",  "Expected string consequence");
    assert.ok(typeof g.zygosity   === "string",   "Expected string zygosity");
    assert.ok(typeof g.study_label === "string",  "Expected string study_label");
    assert.ok(typeof g.study_type  === "string",  "Expected string study_type (EMS|NAT)");
    assert.ok(typeof g.count === "number",        "Expected numeric count");
    assert.ok(Array.isArray(g.accessions),        "Expected accessions array");
    assert.ok(g.accessions.length > 0,            "Expected at least one accession");
    assert.ok(typeof g.accessions[0].ens_id === "string",
      "Expected ens_id string on each accession");
  });

  it("zygosity values are 'homozygous' or 'heterozygous'", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId] },
    });
    const groups = toolResult(res).genes[REAL.geneId].groups;
    for (const g of groups) {
      assert.ok(
        g.zygosity === "homozygous" || g.zygosity === "heterozygous",
        `Unexpected zygosity value: "${g.zygosity}"`
      );
    }
  });

  it("include_germplasm_details=false returns accessions without metadata enrichment", async () => {
    const res = await rpc("tools/call", {
      name: "vep_for_gene",
      arguments: { gene_ids: [REAL.geneId], include_germplasm_details: false },
    });
    const gene = toolResult(res).genes[REAL.geneId];
    assert.ok(gene.summary.total_lof_accessions > 0, "Expected accessions even without details");
    // With include_germplasm_details=false, accessions should only have ens_id
    if (gene.groups.length > 0 && gene.groups[0].accessions.length > 0) {
      const acc = gene.groups[0].accessions[0];
      assert.ok(typeof acc.ens_id === "string", "Expected ens_id");
      assert.ok(!acc.pub_id, "Expected no pub_id when details disabled");
    }
  });
});

// ─── enrichment_analysis ──────────────────────────────────────────────

describe("enrichment_analysis — tool registration", () => {
  it("enrichment_analysis appears in tools/list", async () => {
    const res = await rpc("tools/list");
    const tools = res.result?.tools ?? [];
    const tool = tools.find((t) => t.name === "enrichment_analysis");
    assert.ok(tool, "Expected enrichment_analysis in tools/list");
    assert.ok(tool.inputSchema?.properties?.foreground_fq, "Expected foreground_fq in schema");
    assert.ok(tool.inputSchema?.properties?.background_fq, "Expected background_fq in schema");
    assert.ok(tool.inputSchema?.properties?.field, "Expected field in schema");
  });

  it("requires foreground_fq and background_fq params", async () => {
    const res = await rpc("tools/call", { name: "enrichment_analysis", arguments: {} });
    const hasError = res.error != null
      || res.result?.content?.[0]?.text?.includes("requires")
      || res.result?.isError === true;
    assert.ok(hasError, "Expected error when fq params missing");
  });
});

describe("enrichment_analysis — GO enrichment for jasmonic acid pathway genes", () => {
  it("returns enriched GO terms for JA pathway genes vs sorghum background", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        p_threshold: 0.05,
      },
    });
    const data = toolResult(res);
    assert.ok(data, "Expected a result");
    assert.ok(data.foreground_count > 0, "Expected foreground genes > 0");
    assert.ok(data.background_count > 0, "Expected background genes > 0");
    assert.ok(data.background_count > data.foreground_count,
      "Background should be larger than foreground");
    assert.ok(data.terms_tested > 0, "Expected some terms tested");
    assert.ok(data.significant_terms > 0,
      "Expected at least one significant GO term for JA pathway genes");
  });

  it("enriched terms have expected shape and are sorted by p_adjusted", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
      },
    });
    const terms = toolResult(res).terms;
    assert.ok(terms.length > 0, "Expected significant terms");
    const t = terms[0];
    assert.ok(typeof t.term_id === "number", "Expected numeric term_id");
    assert.ok(typeof t.term_name === "string" && t.term_name.length > 0,
      "Expected resolved term_name");
    assert.ok(typeof t.foreground_count === "number", "Expected foreground_count");
    assert.ok(typeof t.background_count === "number", "Expected background_count");
    assert.ok(typeof t.fold_enrichment === "number", "Expected fold_enrichment");
    assert.ok(typeof t.p === "number", "Expected p-value");
    assert.ok(typeof t.p_adjusted === "number", "Expected p_adjusted");

    // Should be sorted by p_adjusted ascending
    for (let i = 1; i < terms.length; i++) {
      assert.ok(terms[i].p_adjusted >= terms[i-1].p_adjusted,
        `Terms should be sorted by p_adjusted: ${terms[i-1].p_adjusted} > ${terms[i].p_adjusted}`);
    }
  });

  it("fold_enrichment > 1 for significantly enriched terms", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
      },
    });
    const terms = toolResult(res).terms;
    for (const t of terms) {
      assert.ok(t.fold_enrichment > 1,
        `Expected fold_enrichment > 1 for enriched term "${t.term_name}", got ${t.fold_enrichment}`);
    }
  });

  it("p_adjusted <= p_threshold for all returned terms", async () => {
    const threshold = 0.01;
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        p_threshold: threshold,
      },
    });
    const terms = toolResult(res).terms;
    for (const t of terms) {
      assert.ok(t.p_adjusted <= threshold,
        `Expected p_adjusted <= ${threshold}, got ${t.p_adjusted} for "${t.term_name}"`);
    }
  });
});

describe("enrichment_analysis — pathway enrichment for a gene family", () => {
  it("returns pathway enrichment for a gene tree vs sorghum background", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: [`gene_tree:${REAL.geneTree}`],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "pathways__ancestors",
        p_threshold: 0.05,
      },
    });
    const data = toolResult(res);
    assert.ok(data.foreground_count > 0, "Expected foreground genes");
    assert.ok(data.background_count > data.foreground_count,
      "Background should be larger");
    // May or may not have significant terms — just verify structure
    assert.ok(typeof data.significant_terms === "number",
      "Expected significant_terms count");
    assert.ok(Array.isArray(data.terms), "Expected terms array");
  });
});

describe("enrichment_analysis — domain enrichment", () => {
  it("finds enriched InterPro domains for JA pathway genes", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "domains__ancestors",
        p_threshold: 0.05,
      },
    });
    const data = toolResult(res);
    assert.ok(data.foreground_count > 0, "Expected foreground genes");
    // JA biosynthesis genes should have enriched lipoxygenase/AOS domains
    assert.ok(data.significant_terms > 0,
      "Expected enriched domains for JA pathway genes");
  });
});

// ─── enrichment_analysis — include_ancestors DAG ──────────────────────

describe("enrichment_analysis — include_ancestors DAG", () => {
  it("include_ancestors=true returns a dag object with nodes and roots", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: true,
      },
    });
    const data = toolResult(res);
    assert.ok(data.dag, "Expected dag object in response");
    assert.ok(data.dag.node_count > 0, "Expected node_count > 0");
    assert.ok(Array.isArray(data.dag.root_ids), "Expected root_ids array");
    assert.ok(data.dag.root_ids.length > 0, "Expected at least one root");
    assert.ok(typeof data.dag.nodes === "object", "Expected nodes object");
  });

  it("DAG nodes have required structure (id, name, is_a, children)", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: true,
      },
    });
    const nodes = toolResult(res).dag.nodes;
    for (const [id, node] of Object.entries(nodes)) {
      assert.ok(typeof node.id === "number", `Expected numeric id, got ${typeof node.id}`);
      assert.ok(typeof node.name === "string", `Expected string name for ${id}`);
      assert.ok(Array.isArray(node.is_a), `Expected is_a array for ${id}`);
      assert.ok(Array.isArray(node.children), `Expected children array for ${id}`);
    }
  });

  it("DAG includes more nodes than enriched terms (ancestor context)", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: true,
      },
    });
    const data = toolResult(res);
    assert.ok(data.dag.node_count >= data.significant_terms,
      "DAG should have at least as many nodes as enriched terms (plus ancestor context)");
  });

  it("enriched DAG nodes have fold_enrichment and p_adjusted", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: true,
      },
    });
    const nodes = toolResult(res).dag.nodes;
    const enrichedNodes = Object.values(nodes).filter((n) => n.enriched);
    assert.ok(enrichedNodes.length > 0, "Expected at least one enriched node");
    for (const n of enrichedNodes) {
      assert.ok(typeof n.fold_enrichment === "number", `Expected fold_enrichment on enriched node ${n.id}`);
      assert.ok(typeof n.p_adjusted === "number", `Expected p_adjusted on enriched node ${n.id}`);
      assert.ok(typeof n.foreground_count === "number", `Expected foreground_count on enriched node ${n.id}`);
    }
  });

  it("root nodes have no parents (is_a is empty)", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: true,
      },
    });
    const { nodes, root_ids } = toolResult(res).dag;
    for (const rid of root_ids) {
      assert.ok(nodes[rid], `Root ${rid} should exist in nodes`);
      assert.deepStrictEqual(nodes[rid].is_a, [],
        `Root node ${rid} should have empty is_a`);
    }
  });

  it("include_ancestors=false does NOT return a dag object", async () => {
    const res = await rpc("tools/call", {
      name: "enrichment_analysis",
      arguments: {
        foreground_fq: ["pathways__ancestors:1119332", "taxonomy__ancestors:4558"],
        background_fq: ["taxonomy__ancestors:4558"],
        field: "GO__ancestors",
        include_ancestors: false,
      },
    });
    const data = toolResult(res);
    assert.ok(!data.dag, "Expected NO dag when include_ancestors=false");
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
    assert.ok(res.result.isError || res.error, "Should error when gene_ids missing");
  });

  it("returns paper metadata for a gene with known publications", async () => {
    // SORBI_3006G095600 has PUBMED__xrefs: ["31597271"] (Gladman et al. 2019)
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3006G095600"] },
    });
    const data = toolResult(res);
    assert.ok(data.gene_count >= 1, "Should find the gene");
    assert.ok(data.genes_with_papers >= 1, "Gene should have papers");
    const gene = data.genes["SORBI_3006G095600"];
    assert.ok(gene, "Gene entry should exist");
    assert.ok(gene.count >= 1, "Should have at least 1 paper");
    const paper = gene.papers[0];
    assert.ok(paper.pmid, "Paper should have a pmid");
    assert.ok(paper.title, "Paper should have a title");
    assert.ok(paper.title.length > 10, "Title should be a real title");
    assert.ok(paper.authors && paper.authors.length > 0, "Should have authors");
    assert.ok(paper.journal, "Should have a journal");
    assert.ok(paper.url.includes("pubmed"), "Should have a PubMed URL");
  });

  it("returns empty papers for a gene without publications", async () => {
    // Use a gene that does NOT have capabilities:pubs
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3001G000100"] },
    });
    const data = toolResult(res);
    const gene = data.genes["SORBI_3001G000100"];
    assert.ok(gene, "Gene entry should exist even without papers");
    assert.equal(gene.count, 0, "Should have 0 papers");
  });

  it("include_abstract returns abstract text", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3006G095600"], include_abstract: true },
    });
    const data = toolResult(res);
    const gene = data.genes["SORBI_3006G095600"];
    assert.ok(gene.count >= 1, "Should have papers");
    const paper = gene.papers[0];
    assert.ok(paper.abstract, "Should have an abstract when include_abstract=true");
    assert.ok(paper.abstract.length > 50, "Abstract should be substantial text");
  });

  it("handles multiple genes in a single call", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: {
        gene_ids: ["SORBI_3006G095600", "SORBI_3001G000100", "SORBI_3009G083300"],
      },
    });
    const data = toolResult(res);
    assert.equal(Object.keys(data.genes).length, 3, "Should return entries for all 3 genes");
    assert.ok(data.total_unique_papers >= 1, "Should have at least 1 paper total");
  });

  it("handles rice genes with DOI-only refs", async () => {
    // Os01g0102400 has both PMID and DOI refs
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["Os01g0102400"] },
    });
    const data = toolResult(res);
    const gene = data.genes["Os01g0102400"];
    assert.ok(gene, "Rice gene entry should exist");
    assert.ok(gene.count >= 1, "Should have at least 1 paper");
  });

  it("returns DOI and URL fields for papers", async () => {
    const res = await rpc("tools/call", {
      name: "pubmed_for_genes",
      arguments: { gene_ids: ["SORBI_3006G095600"] },
    });
    const data = toolResult(res);
    const paper = data.genes["SORBI_3006G095600"].papers[0];
    assert.ok(paper.doi, "Paper should have a DOI");
    assert.ok(paper.url, "Paper should have a URL");
  });
});
