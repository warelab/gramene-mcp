# HTML Report Patterns

Reference patterns for building the QTL candidate analysis HTML report.
Read this file when generating the HTML output.

## Table of Contents
1. Page structure and CSS
2. Sortable table pattern
3. Collapsible gene cards
4. Expression chart (Chart.js)
5. DAG ontology tree
6. CNV heatmap

---

## 1. Page Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QTL Candidate Analysis — [trait] [species] [region]</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    /* --- Base --- */
    :root {
      --enriched: #2e7d32; --enriched-bg: #e8f5e9;
      --absent: #c62828;   --absent-bg: #ffebee;
      --neutral: #757575;  --neutral-bg: #f5f5f5;
      --primary: #1565c0;  --primary-bg: #e3f2fd;
      --border: #e0e0e0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6;
           max-width: 1200px; margin: 0 auto; padding: 20px; color: #333; }
    h1 { font-size: 1.6em; margin-bottom: 0.5em; }
    h2 { font-size: 1.3em; margin: 1.5em 0 0.5em; border-bottom: 2px solid var(--primary);
         padding-bottom: 0.3em; }
    h3 { font-size: 1.1em; margin: 1em 0 0.3em; }

    /* --- Tables --- */
    table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
    th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
    th { background: var(--primary-bg); cursor: pointer; user-select: none; position: sticky; top: 0; }
    th:hover { background: #bbdefb; }
    tr:nth-child(even) { background: #fafafa; }
    tr:hover { background: #f0f7ff; }

    /* --- Score bars --- */
    .score-bar { display: inline-block; height: 14px; border-radius: 2px;
                 background: var(--primary); min-width: 2px; }
    .score-cell { white-space: nowrap; }

    /* --- Gene cards --- */
    details.gene-card { border: 1px solid var(--border); border-radius: 6px;
                        margin: 0.5em 0; padding: 0; }
    details.gene-card summary { padding: 10px 15px; cursor: pointer; font-weight: 600;
                                 background: #fafafa; border-radius: 6px; }
    details.gene-card[open] summary { border-bottom: 1px solid var(--border);
                                       border-radius: 6px 6px 0 0; }
    details.gene-card .card-body { padding: 15px; }
    .card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }

    /* --- DAG tree --- */
    .dag-tree ul { list-style: none; padding-left: 20px; }
    .dag-tree li { position: relative; }
    .dag-tree .node-label { padding: 3px 8px; border-radius: 4px; cursor: pointer;
                            display: inline-block; margin: 2px 0; }
    .dag-tree .enriched .node-label { background: var(--enriched-bg); color: var(--enriched);
                                       font-weight: 600; }
    .dag-tree .ancestor .node-label { background: var(--neutral-bg); color: var(--neutral); }
    .dag-tree .fold-bar { display: inline-block; height: 10px; background: var(--enriched);
                          border-radius: 2px; margin-left: 6px; vertical-align: middle; }
    .dag-tree .collapsed > ul { display: none; }
    .dag-tree .toggle { cursor: pointer; font-family: monospace; width: 1.2em;
                        display: inline-block; text-align: center; }

    /* --- Chips/badges --- */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px;
             font-size: 0.75em; font-weight: 600; margin: 0 2px; }
    .badge-ems { background: #fff3e0; color: #e65100; }
    .badge-nat { background: #e8eaf6; color: #283593; }
    .badge-lof { background: var(--absent-bg); color: var(--absent); }
    .badge-expr { background: var(--enriched-bg); color: var(--enriched); }
    .badge-pav { background: #fce4ec; color: #880e4f; }

    /* --- Charts --- */
    .chart-container { position: relative; width: 100%; max-width: 800px; margin: 1em auto; }

    /* --- Buttons --- */
    .btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 4px;
           background: white; cursor: pointer; font-size: 0.85em; margin: 2px; }
    .btn:hover { background: #f5f5f5; }
    .btn.active { background: var(--primary-bg); border-color: var(--primary); }

    /* --- Print --- */
    @media print {
      details[open] summary ~ * { display: block !important; }
      details { break-inside: avoid; }
      .no-print { display: none; }
      th { background: #eee !important; }
    }
  </style>
</head>
<body>
  <!-- Sections go here -->
  <script>
    // DATA objects are embedded here as const declarations
    // const GENES = [...];
    // const ENRICHMENT = {...};
    // const DAG_DATA = {...};
    // etc.
  </script>
</body>
</html>
```

## 2. Sortable Table

```javascript
function makeSortable(table) {
  const headers = table.querySelectorAll('th');
  headers.forEach((th, colIdx) => {
    th.addEventListener('click', () => {
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;
      headers.forEach(h => h.textContent = h.textContent.replace(/ [▲▼]/, ''));
      th.textContent += dir === 'asc' ? ' ▲' : ' ▼';
      rows.sort((a, b) => {
        let va = a.cells[colIdx].dataset.value ?? a.cells[colIdx].textContent;
        let vb = b.cells[colIdx].dataset.value ?? b.cells[colIdx].textContent;
        const na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return dir === 'asc' ? na - nb : nb - na;
        return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
      const tbody = table.querySelector('tbody');
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}
document.querySelectorAll('table.sortable').forEach(makeSortable);
```

## 3. Collapsible Gene Card

```html
<details class="gene-card" id="gene-SORBI_3006G095600">
  <summary>
    <span class="rank">#1</span>
    <strong>SORBI_3006G095600</strong> — LOX3 (lipoxygenase 3)
    <span class="badge badge-expr">TPM 42.3</span>
    <span class="badge badge-lof">5 LOF</span>
    <span style="float:right">Score: 14/17</span>
  </summary>
  <div class="card-body">
    <div class="card-grid">
      <div>
        <h4>Position</h4>
        <p>Chr6: 52,341,200–52,345,800 (+)</p>
        <h4>Orthologs</h4>
        <p>Rice: Os04g0447100 (LOX3, 78% id)<br>
           Maize: Zm00001eb412300 (LOX8, 71% id)</p>
      </div>
      <div>
        <h4>Expression</h4>
        <canvas id="expr-SORBI_3006G095600" width="300" height="150"></canvas>
      </div>
    </div>
    <!-- More sections: LOF, Literature, Annotations -->
  </div>
</details>
```

## 4. Expression Chart Pattern

```javascript
function renderExpressionChart(canvasId, geneData) {
  // geneData = { tissues: ["leaf", "root", ...], values: [42.3, 12.1, ...] }
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: geneData.tissues,
      datasets: [{
        label: 'TPM',
        data: geneData.values,
        backgroundColor: geneData.values.map(v =>
          v > 20 ? 'rgba(46,125,50,0.7)' :
          v > 5  ? 'rgba(255,152,0,0.7)' :
                   'rgba(189,189,189,0.7)')
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: 'TPM' } } }
    }
  });
}
```

## 5. DAG Ontology Tree

Build recursively from the `dag` response object:

```javascript
function renderDagTree(container, dagData) {
  const { root_ids, nodes } = dagData;

  function buildNode(id) {
    const node = nodes[id];
    if (!node) return '';
    const hasChildren = node.children && node.children.length > 0;
    const cls = node.enriched ? 'enriched' : 'ancestor';
    const toggle = hasChildren ? '<span class="toggle">▼</span>' : '<span class="toggle"> </span>';
    let label = `${toggle}<span class="node-label">${node.name} (${node.id})</span>`;
    if (node.enriched) {
      const barW = Math.min(node.fold_enrichment * 10, 100);
      label += `<span class="fold-bar" style="width:${barW}px" title="fold: ${node.fold_enrichment.toFixed(1)}"></span>`;
      label += ` <small>p=${node.p_adjusted.toExponential(2)}, ${node.foreground_count} genes</small>`;
    }
    let html = `<li class="${cls}${hasChildren ? '' : ' leaf'}">${label}`;
    if (hasChildren) {
      html += '<ul>' + node.children.map(buildNode).join('') + '</ul>';
    }
    html += '</li>';
    return html;
  }

  container.innerHTML = '<ul>' + root_ids.map(buildNode).join('') + '</ul>';

  // Toggle expand/collapse on click
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('toggle')) {
      const li = e.target.closest('li');
      li.classList.toggle('collapsed');
      e.target.textContent = li.classList.contains('collapsed') ? '▶' : '▼';
    }
  });
}
```

## 6. CNV Table Pattern

```html
<table class="sortable">
  <thead>
    <tr>
      <th>Gene Family</th>
      <th>Reference Gene</th>
      <!-- One column per genome -->
      <th>BTx623</th><th>Tx430</th><th>Rio</th><!-- etc -->
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>SB10GT_332720</td>
      <td>SORBI_3006G095600</td>
      <td data-value="1" style="background:#e8f5e9">1</td>
      <td data-value="2" style="background:#fff3e0">2</td>
      <td data-value="0" style="background:#ffebee">0</td>
    </tr>
  </tbody>
</table>
```

Color cells: green=1 (single copy), orange=>1 (CNV), red=0 (absent/PAV).
