---
name: qtl-candidate-analysis
description: >
  Comprehensive QTL candidate gene analysis using the Gramene/Sorghumbase MCP server.
  Expression-driven pipeline: identifies genes in a QTL region, profiles their expression
  and their orthologs' expression across tissues, connects expression patterns to the
  trait of interest, then supplements with functional annotations, literature, LOF alleles,
  and copy number variation. Produces a ranked candidate list and interactive HTML report.
  Use this skill whenever the user asks about: QTL analysis, candidate gene identification,
  genes in a genomic interval, prioritizing genes under a QTL peak, trait-associated region
  analysis, or any request that combines positional gene data with functional annotation
  for gene ranking. Also trigger when the user mentions a chromosomal region and a trait
  together, even casually (e.g., "what's interesting on chr3 55-58Mb for yield in sorghum").
---

# QTL Candidate Gene Analysis

You are running a multi-step candidate gene analysis for a QTL (quantitative trait locus)
region. The goal is to identify, annotate, and rank genes under a QTL peak to help a
plant biologist prioritize candidates for experimental validation.

The analysis uses the Gramene MCP server tools. Read the `AGENT_PROMPT.md` system prompt
if you haven't already — it documents every tool, field, and workflow pattern you'll need.

## Guiding Principle: Expression First

Gene expression is the most informative single signal for QTL candidate prioritization.
A gene that is highly and specifically expressed in the trait-relevant tissue — and whose
ortholog in a well-studied species shows the same pattern — is far more likely to be
causal than a gene identified only by position and annotation keywords.

The pipeline below is structured so that expression profiling happens early and drives
the ranking. The supplementary analyses (VEP, CNV, enrichment, literature) refine and
contextualize the expression-based ranking but don't replace it.

---

## Input Resolution

The user will provide one of:

**A. Direct coordinates:** chromosome, start, end, and species.
Parse these and proceed to the gene scan.

**B. A trait name or TO term:** e.g., "grain yield", "plant height", "TO:0000396".
Resolve to QTL interval(s):

```
# 1. Find the TO term
mongo_find(collection: "TO", filter: { "name": { "$regex": "<trait>", "$options": "i" } })
  → get the TO integer ID (e.g., 396 for grain yield)

# 2. Find QTL intervals for that trait in the target species
mongo_find(collection: "qtls",
           filter: { "terms": "TO:<padded_id>", "taxon_id": <taxon_id> },
           projection: { location: 1, terms: 1, name: 1 })
  → each result has location.region, location.start, location.end
```

If multiple QTLs are returned, present them to the user and ask which one(s) to analyze.
If none are found, tell the user and ask if they can provide coordinates directly.

**Species resolution:** If the user names a species but not a taxon_id, resolve it:
```
solr_suggest(q='name:"<species name>"')
  → fq_field=taxonomy__ancestors, fq_value=<taxon_id>
```

**Trait-to-tissue mapping:** Before starting the pipeline, map the trait to relevant
plant tissues. This mapping guides the expression analysis. Common mappings:

| Trait category | PO terms (integer IDs) | Tissues |
|---------------|----------------------|---------|
| Grain yield / seed | 9001, 9089, 9010 | fruit/grain, endosperm, seed |
| Plant height / growth | 20142, 25029, 9047 | stem internode, shoot, stem |
| Flowering time | 9051, 9049, 6310 | spikelet, inflorescence, flower |
| Root traits | 9005, 25025, 20127 | root, root system, primary root |
| Drought / abiotic stress | 25034, 9005 | leaf, root |
| Grain quality | 9001, 9089 | fruit/grain, endosperm |

If the trait doesn't map neatly, fetch all baseline expression first, then identify
the most discriminating tissues from the data itself.

---

## Pipeline Steps

### Step 1: Gene Scan and Ortholog Resolution

```
genes_in_region(
  region: "<chr>", start: <start>, end: <end>,
  taxon_id: <taxon_id>,
  fl: "id,name,description,biotype,start,end,strand,gene_tree,
       homology__ortholog_one2one,homology__all_orthologs,
       GO__ancestors,TO__ancestors,PO__ancestors,
       pathways__ancestors,domains__ancestors,
       capabilities,PUBMED__xrefs,compara_idx_multi,
       closest_rep_id,closest_rep_name,closest_rep_description,closest_rep_taxon_id,closest_rep_identity,
       model_rep_id,model_rep_name,model_rep_description,model_rep_taxon_id,model_rep_identity",
  rows: 500
)
```

Record total gene count. Filter to `biotype:protein_coding` for the primary analysis.

For each protein-coding gene, extract orthologs from `homology__ortholog_one2one`.
Collect rice (Os...), maize (Zm...), and Arabidopsis (AT...) orthologs specifically.
If `homology__ortholog_one2one` is empty, fall back to `homology__all_orthologs`.

Build a mapping: `{ query_gene → { rice_ortholog, maize_ortholog, arab_ortholog } }`.

**Gene display names (REQUIRED in all tables and cards):**
Many genes in non-model species carry no human-readable name (the `name` field equals
the stable ID). Always resolve a display name using this priority chain:
1. `name` — use if it differs from the stable ID
2. `closest_rep_name` — closest homolog, typically in rice for sorghum genes
3. `model_rep_name` — homolog in Arabidopsis
4. First word of `description`
5. Stable ID alone (last resort)

Display every gene as: **`GENE_ID / NAME`** with the description as a tooltip or
sub-line — e.g., `SORBI_3006G147000 / RPL14B` or `Os01g0700500 / GS3 (grain size)`.
Never render a bare stable ID without at least a closest-rep or model-rep name alongside it.
This applies to the ranked candidate table, gene detail cards, chart labels, and the
executive summary.

### Step 2: Expression Profiling (Primary Analysis)

This is the most important step. It requires ALL of the calls below — not just the
first one. Sorghum, rice, maize, Arabidopsis, wheat, soybean, and grapevine all have
baseline expression data in the database. If a call returns empty results, that's a
bug in how you made the call (wrong taxon_id, wrong gene ID format, etc.) — debug it
rather than concluding "no data available."

You need to make at least 3 expression calls and extract actual TPM numbers from each.
The final report must contain real numeric TPM values, not placeholders or "data
recommended for validation." If you don't have numbers, the analysis is incomplete.

**2a. Baseline expression in the target species (REQUIRED):**
```
expression_for_genes(
  gene_ids: <all protein-coding gene IDs — batch in groups of 200 if >200>,
  experiment_type: "Baseline",
  taxon_id: <NCBI taxon_id, e.g. 4558 for sorghum — NOT the assembly-specific one>
)
```
Extract the max TPM per tissue per gene. Build a matrix: genes × tissues.
Identify trait-relevant tissues and rank genes by expression in those tissues.
Sorghum typically returns ~50 baseline entries per gene across 20+ tissues.

**2b. Baseline expression of orthologs in rice (REQUIRED):**
```
expression_for_genes(
  gene_ids: <all rice ortholog IDs — batch if >200>,
  experiment_type: "Baseline",
  taxon_id: 4530
)
```
This is NOT optional. Rice has the richest expression atlas. Even when the target
species returns full data, you still need rice to check for conserved expression
patterns. Extract max TPM per tissue per gene. Map back to the query gene via
the ortholog mapping from Step 1.

**2c. Baseline expression of orthologs in maize:**
```
expression_for_genes(
  gene_ids: <all maize ortholog IDs>,
  experiment_type: "Baseline",
  taxon_id: 4577
)
```

**2d. Differential expression in the target species:**
```
expression_for_genes(
  gene_ids: <all protein-coding gene IDs>,
  experiment_type: "Differential",
  taxon_id: <NCBI taxon_id>
)
```
Look for genes significantly DE (p < 0.05) under conditions related to the trait.

**2e. Differential expression of rice orthologs:**
```
expression_for_genes(
  gene_ids: <rice ortholog IDs>,
  experiment_type: "Differential",
  taxon_id: 4530
)
```

**What you must extract and embed in the report:**

For each gene, compute and store these numbers (they go into the HTML as JS data):
- `leaf_expr`: max TPM in leaf/flag leaf tissue
- `root_expr`: max TPM in root/root system tissue
- `seed_expr`: max TPM in seed/grain/endosperm tissue
- `max_tissue`: name of the tissue with highest expression
- `max_tpm`: the TPM value in that tissue
- `rice_leaf_expr`, `rice_root_expr`, `rice_seed_expr`: same for the rice ortholog
- `de_conditions`: any significant DE results (condition, log2FC, p-value)

These numbers drive the ranking and MUST appear in the report as:
1. Embedded JS data objects powering the Chart.js visualizations
2. Numeric columns in the candidate ranking table
3. Bar charts in each gene detail card

**Interpreting expression for candidate ranking:**

For each gene, build an expression profile that answers:
1. **Is it expressed in the right tissue?** A yield QTL candidate should be expressed
   in grain/seed tissue. A height candidate in stem/internode. Drought in leaf/root.
2. **How highly?** Rank within the QTL region. Top quartile gets full score.
3. **Is it tissue-specific or ubiquitous?** Tissue-specific expression in the
   trait-relevant tissue is a stronger signal than ubiquitous expression.
4. **Does the ortholog show the same pattern?** Conserved tissue-specific expression
   across species is strong evidence for functional importance.
5. **Is it differentially expressed under trait-relevant conditions?** Significant
   DE (|log2FC| > 1, p < 0.05) is direct functional evidence.

### Step 3: Functional Annotation and Literature

**3a. Resolve ontology terms:**
```
mongo_lookup_by_ids(collection: "GO", ids: [<unique GO ints>])
mongo_lookup_by_ids(collection: "TO", ids: [<unique TO ints>])
mongo_lookup_by_ids(collection: "pathways", ids: [<unique pathway ints>])
mongo_lookup_by_ids(collection: "domains", ids: [<unique domain ints>])
```

Flag genes whose TO annotations overlap with the query trait's TO hierarchy.
Also flag genes whose GO terms or pathway membership is biologically relevant to the
trait — e.g., for a yield QTL, genes in starch biosynthesis or sugar transport pathways
are high-value candidates even without a direct TO annotation.

**3b. Literature search:**
```
pubmed_for_genes(
  gene_ids: <all protein-coding genes + all collected orthologs>,
  include_abstract: true
)
```
Scan abstracts for functional evidence. A gene whose rice ortholog has been knocked out
and studied for the relevant phenotype is extremely strong evidence.

### Step 4: Supplementary Analyses

These provide additional context and refinement. They are valuable but secondary to
expression and functional annotation.

**4a. Loss-of-Function Alleles (VEP):**
```
vep_for_gene(gene_ids: <all protein-coding gene IDs>, include_germplasm_details: true)
```
Flag genes with EMS homozygous knockouts (validation-ready) and natural LOF alleles.
Batch in groups of 50 if needed. Not all species have VEP data — skip gracefully.

**4b. Copy Number Variation (CNV/PAV):**
```
mongo_find(collection: "maps", filter: { in_compara: true },
           projection: { _id: 1, name: 1, display_name: 1 })

# For key gene trees in the region, facet by system_name
solr_search(q="gene_tree:<tree_id>", rows: 0,
            fq: ["taxonomy__ancestors:<taxon_id>"],
            facet: { field: "system_name", mincount: 0, limit: -1 })
```
Note which genes show PAV (absent in some genomes) or CNV (duplicated). This is
interesting context — a gene that varies in copy number may be under selection — but
it's not a primary ranking signal on its own.

**4c. Enrichment Analysis:**
```
enrichment_analysis(
  foreground_fq: ["region:<chr>", "start:[<start> TO <end>]",
                   "taxonomy__ancestors:<taxon_id>"],
  background_fq: ["taxonomy__ancestors:<taxon_id>"],
  field: "GO__ancestors",
  include_ancestors: true
)
```
Also run on `pathways__ancestors` and `domains__ancestors`.
Enrichment reveals the biological themes in the region. In a QTL context, an enriched
function suggests the causal gene may be involved in that process — but physical linkage
means enrichment alone doesn't point to individual genes.

---

## Candidate Ranking

The ranking is weighted toward expression because expression data directly links a gene
to the trait-relevant biology, while annotations and structural variants provide context.

| Criterion | Weight | Points | How to score |
|-----------|--------|--------|-------------|
| **Expression in trait-relevant tissue** | HIGH | 0–4 | 4 = top 10% in trait tissue + tissue-specific; 3 = top quartile; 2 = expressed above median; 1 = detectable; 0 = not expressed or no data |
| **Conserved ortholog expression** | HIGH | 0–3 | 3 = rice/maize ortholog shows same tissue-specific pattern; 2 = ortholog expressed in relevant tissue but not specific; 1 = ortholog expressed elsewhere; 0 = no ortholog data |
| **Differential expression** | HIGH | 0–3 | 3 = significantly DE in target species under trait condition; 2 = DE in ortholog; 1 = marginally significant; 0 = not DE |
| **Published functional evidence** | MEDIUM | 0–3 | 3 = gene/ortholog directly studied for this trait; 2 = ortholog functionally characterized for related trait; 1 = mentioned in literature; 0 = no pubs |
| **Trait ontology / GO / pathway** | MEDIUM | 0–3 | 3 = direct TO match + relevant GO/pathway; 2 = relevant GO or pathway only; 1 = tangentially related; 0 = no match |
| **Gene description relevance** | LOW | 0–2 | 2 = description directly implies trait-related function; 1 = plausibly related; 0 = uncharacterized or unrelated |
| **LOF germplasm available** | LOW | 0–1 | 1 = EMS or natural LOF alleles exist; 0 = none |
| **CNV/PAV variation** | LOW | 0–1 | 1 = copy number variable across genomes; 0 = conserved single copy |

**Maximum: 20 points.** The top three criteria (expression, ortholog expression, DE)
account for 10/20 points — half the total. This ensures that genes with strong expression
evidence always outrank genes that merely have relevant-sounding annotations.

For each top candidate (top 5–10), write a narrative justification that explains WHY
the expression pattern supports the gene as a candidate. For example: "LOX3 is the
highest-expressed gene in grain tissue within the QTL interval (TPM 42.3), and its
rice ortholog Os04g0447100 shows the same grain-specific pattern (TPM 38.1). It encodes
a lipoxygenase involved in jasmonic acid biosynthesis, consistent with a role in
grain development. EMS knockout lines are available from ARS-GRIN."

---

## Report Structure

Generate a single self-contained HTML file. Use Chart.js from
`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js` for charts.
Read the `references/html-report-patterns.md` file for CSS and component patterns.

### Required Sections (in this order)

**1. Executive Summary**
- Species, QTL interval, trait, gene count
- Top 3–5 candidates with one-sentence rationale emphasizing expression evidence
- Key biological theme from enrichment

**2. Expression Overview (THE CENTRAL FIGURE)**
This is the most important visualization in the report.

Create a grouped bar chart or heatmap showing baseline expression (TPM) of the top
15–20 candidates across multiple tissues. Include trait-relevant tissues prominently.
If ortholog expression data is available, show a companion chart comparing the query
gene's expression profile to its rice/maize ortholog — side by side, same tissues
where possible. This visual immediately shows which genes have the right expression
pattern for the trait.

Include:
- Per-gene expression bar charts in gene cards
- A summary table of max TPM in trait-relevant tissue per gene
- Differential expression results highlighted (significant log2FC values)

**3. Ranked Candidate Table**
Sortable HTML table with columns:
- Rank, Gene ID / Name (show `closest_rep_name` or `model_rep_name` if no own name),
  Description, Total Score, Position
- Key sub-scores: Expr (0–4), Orth Expr (0–3), DE (0–3), Lit (0–3), Annot (0–3)
- Expression value (TPM) in trait tissue as a prominent column
- Rep homolog column: `closest_rep_name` with identity % — helps readers instantly
  recognize genes by their well-known orthologs
- Clicking a gene ID scrolls to its detail card

**4. Gene Detail Cards**
For top 10–15 candidates (use collapsible `<details>` elements):
- Position, strand, gene tree ID
- **Gene name header:** `GENE_ID / name` (own name) or `GENE_ID / closest_rep_name
  (closest_rep_identity%) [closest_rep_taxon_id species]` if no own name, plus
  `model_rep_name (Arabidopsis)` as a cross-reference
- Orthologs with names
- **Expression profile chart** (bar chart of TPM across tissues — this is mandatory)
- Ortholog expression comparison if available
- DE results (conditions, log2FC, p-value)
- Key annotations (GO, pathways, domains) with biological interpretation
- Literature references with context from abstracts
- LOF allele summary (EMS count, NAT count, seed stock links)
- CNV status

**5. Enrichment Results**
- Table of enriched GO terms, pathways, domains with fold enrichment and p-values
- For GO: collapsible DAG tree (from `include_ancestors` response)
- Interpret how enrichment themes relate to the trait

**6. Supplementary Data**
- CNV/PAV table showing copy number per genome per gene family
- Full LOF allele counts
- Complete gene list (abbreviated for low-scoring genes)

**7. Methods**

### HTML Implementation Notes

- Embed all expression data as JavaScript objects so charts render client-side
- Every gene card MUST have an expression chart (even if "no data" — show the orthologs)
- Sortable table with visual score bars
- Color scheme: green = high expression / enriched, grey = neutral, red = absent / LOF
- Print-friendly `@media print` styles

---

## Important Considerations

**Expression data is sometimes sparse.** Not all species have rich expression atlases.
When the target species returns little data, ortholog expression becomes the primary
signal. Don't score a gene 0 for expression just because the target species lacks data —
use the ortholog data. In the report, clearly note which expression values come from
orthologs vs the target species.

**Batch size limits:** `vep_for_gene` max 50 per call. `expression_for_genes` max 500.
`pubmed_for_genes` max 500. Batch accordingly.

**Large QTL regions:** If >500 protein-coding genes, consider focusing expression
analysis on the top 100 by annotation relevance, then back-filling the rest.

**Chromosome naming varies by species.** Sorghum "1"–"10", rice "1"–"12", etc.

**Enrichment in QTL context:** Physical linkage means enrichment may reflect genome
organization rather than trait biology. Use enrichment to generate hypotheses about the
trait mechanism, but rank individual genes by their own expression and annotation, not
by the region's enrichment profile.
