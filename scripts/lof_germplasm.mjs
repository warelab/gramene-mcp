#!/usr/bin/env node
/**
 * lof_germplasm.mjs
 *
 * Look up germplasm with predicted loss-of-function alleles for a list of
 * gene IDs using the Gramene/SorghumBase Solr + MongoDB backend.
 *
 * Usage:
 *   node lof_germplasm.mjs [options] [gene_ids_file]
 *   echo "SORBI_3006G095600" | node lof_germplasm.mjs [options]
 *   node --env-file=.env.squam lof_germplasm.mjs gene_ids.txt
 *
 * Output columns (tab-delimited on stdout):
 *   gene_id     input gene stable ID
 *   population  study/population name  (e.g. "Purdue EMS", "Boatwright SAP")
 *   pop_type    EMS (mutagenesis) or NAT (natural diversity)
 *   consequence VEP consequence        (e.g. "stop gained", "splice acceptor variant")
 *   zygosity    homo or het
 *   accessions  comma-separated public germplasm accession IDs (pub_id)
 *
 * Options:
 *   --solr-url  URL   Solr base URL       (default: $SOLR_BASE_URL  or http://localhost:8983/solr)
 *   --solr-core CORE  Solr genes core     (default: $SOLR_GENES_CORE or genes)
 *   --mongo-uri URI   MongoDB URI         (default: $MONGO_URI       or mongodb://localhost:27017)
 *   --mongo-db  DB    MongoDB database    (default: $MONGO_DB        or test)
 *   --batch-size N    Genes per query     (default: 50)
 *   --header          Print a header line
 *   --no-fallback     Skip accessions with no pub_id (instead of printing ens_id)
 *   --help            Show this help
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// VEP study/population metadata — mirrors VEP_STUDY_INFO in server.mjs
// ---------------------------------------------------------------------------
const VEP_STUDY_INFO = {
  sorghum_bicolor: {
    "1": { label: "Purdue EMS",               type: "EMS" },
    "2": { label: "USDA Lubbock EMS",         type: "EMS" },
    "3": { label: "Lozano",                   type: "NAT" },
    "4": { label: "USDA Lubbock EMS",         type: "EMS" },
    "5": { label: "Boatwright SAP",           type: "NAT" },
    "7": { label: "Kumar BAP",                type: "NAT" },
    "8": { label: "Lasky landraces",          type: "NAT" },
    "9": { label: "Sorghum Genomics Toolbox", type: "NAT" },
  },
  zea_maysb73: {
    "15": { label: "MaizeGDB 2024", type: "NAT" },
  },
  oryza_sativa: {
    "7":  { label: "Rice 3K",            type: "NAT" },
    "20": { label: "19K-RGP",            type: "NAT" },
    "29": { label: "Rice USDA mini core",type: "NAT" },
    "38": { label: "RAPDB 2024",         type: "NAT" },
  },
  oryza_aus:           { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativa117425:  { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativair64rs2: { "20": { label: "19K-RGP", type: "NAT" } },
  oryza_sativamh63:    { "20": { label: "19K-RGP", type: "NAT" } },
};

/**
 * Parse a VEP__ Solr dynamic field name into semantic parts.
 * Format: VEP__{consequence}__{zygosity}__{species}__{study_id}__attr_ss
 * Returns null for merged totals or malformed names.
 */
function parseVepFieldName(fieldName) {
  if (!fieldName.startsWith("VEP__")) return null;
  const parts = fieldName.split("__");
  if (parts[1] === "merged") return null; // skip VEP__merged__EMS/NAT__attr_ss
  if (parts.length >= 6) {
    const [, consequence, zygosityRaw, species, study_id] = parts;
    const studyMap  = VEP_STUDY_INFO[species] ?? {};
    const studyInfo = studyMap[study_id] ?? { label: `Study ${study_id}`, type: "unknown" };
    return {
      consequence:  consequence.replaceAll("_", " "),
      zygosity:     zygosityRaw === "homo" ? "homo" : "het",
      species,
      study_id,
      study_label:  studyInfo.label,
      study_type:   studyInfo.type,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Solr helper
// ---------------------------------------------------------------------------
async function solrFetchVep(baseUrl, core, geneIds) {
  const q = geneIds.length === 1
    ? `id:${geneIds[0]}`
    : `id:(${geneIds.join(" OR ")})`;

  const params = new URLSearchParams({
    q,
    fl:   "id,VEP__*",
    rows: String(geneIds.length),
    wt:   "json",
  });

  const url = `${baseUrl.replace(/\/$/, "")}/${core}/select?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Solr HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.response?.docs ?? [];
}

// ---------------------------------------------------------------------------
// MongoDB helper
// ---------------------------------------------------------------------------
async function fetchGermplasmMetadata(collection, ensIds) {
  if (!ensIds.size) return new Map();
  const docs = await collection
    .find({ _id: { $in: [...ensIds] } }, { projection: { pub_id: 1, stock_center: 1, subpop: 1 } })
    .toArray();
  return new Map(docs.map((d) => [d._id, d]));
}

// ---------------------------------------------------------------------------
// Row emission
// ---------------------------------------------------------------------------
function* emitRows(solrDocs, germplasmMap, noFallback = false) {
  for (const doc of solrDocs) {
    const geneId = doc.id ?? "";
    for (const [field, values] of Object.entries(doc).sort()) {
      if (!field.startsWith("VEP__") || !Array.isArray(values)) continue;
      const parsed = parseVepFieldName(field);
      if (!parsed) continue;

      const pubIds = [];
      for (const ensId of values) {
        const g = germplasmMap.get(ensId);
        if (g?.pub_id) {
          pubIds.push(g.pub_id);
        } else if (!noFallback) {
          pubIds.push(ensId); // fall back to internal ens_id
        }
      }
      if (!pubIds.length) continue;

      yield [
        geneId,
        parsed.study_label,
        parsed.study_type,
        parsed.consequence,
        parsed.zygosity,
        pubIds.join(","),
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    inputFile:   null,
    solrUrl:     null,
    solrCore:    null,
    mongoUri:    null,
    mongoDb:     null,
    batchSize:   50,
    header:      false,
    noFallback:  false,
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--help": case "-h":
        process.stdout.write(
          "Usage: node lof_germplasm.mjs [options] [gene_ids_file]\n\n" +
          "  --solr-url URL    Solr base URL\n" +
          "  --solr-core CORE  Solr genes core name\n" +
          "  --mongo-uri URI   MongoDB URI\n" +
          "  --mongo-db DB     MongoDB database name\n" +
          "  --batch-size N    Genes per Solr query (default: 50)\n" +
          "  --header          Print TSV header line\n" +
          "  --no-fallback     Skip accessions with no pub_id\n" +
          "  --help            This message\n\n" +
          "Environment variables: SOLR_BASE_URL, SOLR_GENES_CORE, MONGO_URI, MONGO_DB\n" +
          "  (can also be set via: node --env-file=.env.squam lof_germplasm.mjs)\n"
        );
        process.exit(0);
        break;
      case "--solr-url":   args.solrUrl    = rest[++i]; break;
      case "--solr-core":  args.solrCore   = rest[++i]; break;
      case "--mongo-uri":  args.mongoUri   = rest[++i]; break;
      case "--mongo-db":   args.mongoDb    = rest[++i]; break;
      case "--batch-size": args.batchSize  = parseInt(rest[++i], 10); break;
      case "--header":     args.header     = true; break;
      case "--no-fallback":args.noFallback = true; break;
      default:
        if (!rest[i].startsWith("--")) args.inputFile = rest[i];
        else { process.stderr.write(`Unknown option: ${rest[i]}\n`); process.exit(1); }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Read lines from a stream (file or stdin)
// ---------------------------------------------------------------------------
async function readLines(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) lines.push(trimmed);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  const solrUrl  = args.solrUrl  ?? process.env.SOLR_BASE_URL   ?? "http://localhost:8983/solr";
  const solrCore = args.solrCore ?? process.env.SOLR_GENES_CORE ?? "genes";
  const mongoUri = args.mongoUri ?? process.env.MONGO_URI        ?? "mongodb://localhost:27017";
  const mongoDb  = args.mongoDb  ?? process.env.MONGO_DB         ?? "test";

  // Read gene IDs from file or stdin
  const inputStream = args.inputFile
    ? createReadStream(args.inputFile)
    : process.stdin;

  const geneIds = await readLines(inputStream);
  if (!geneIds.length) {
    process.stderr.write("No gene IDs provided.\n");
    process.exit(1);
  }
  process.stderr.write(`Processing ${geneIds.length} gene ID(s)...\n`);

  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const germplasmColl = mongo.db(mongoDb).collection("germplasm");

  const out = process.stdout;

  if (args.header) {
    out.write("gene_id\tpopulation\tpop_type\tconsequence\tzygosity\taccessions\n");
  }

  const { batchSize } = args;
  for (let i = 0; i < geneIds.length; i += batchSize) {
    const batch    = geneIds.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    process.stderr.write(`  Batch ${batchNum}: querying ${batch.length} gene(s)...\n`);

    let docs;
    try {
      docs = await solrFetchVep(solrUrl, solrCore, batch);
    } catch (err) {
      process.stderr.write(`  ERROR querying Solr: ${err.message}\n`);
      continue;
    }

    // Collect all ens_ids for MongoDB lookup
    const allEnsIds = new Set();
    for (const doc of docs) {
      for (const [field, values] of Object.entries(doc)) {
        if (field.startsWith("VEP__") && Array.isArray(values)) {
          values.forEach((v) => allEnsIds.add(v));
        }
      }
    }

    let germplasmMap;
    try {
      germplasmMap = await fetchGermplasmMetadata(germplasmColl, allEnsIds);
    } catch (err) {
      process.stderr.write(`  WARNING: MongoDB lookup failed (${err.message}); using ens_ids\n`);
      germplasmMap = new Map();
    }

    // Warn about missing genes
    const foundIds = new Set(docs.map((d) => d.id));
    const missing  = batch.filter((g) => !foundIds.has(g));
    if (missing.length) {
      process.stderr.write(`  WARNING: no Solr document found for: ${missing.join(", ")}\n`);
    }

    for (const row of emitRows(docs, germplasmMap, args.noFallback)) {
      out.write(row.join("\t") + "\n");
    }
  }

  await mongo.close();
  process.stderr.write("Done.\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
