// Personalized PageRank over the file reference graph.
//
// Retrieval ranks files by how well their text matches a query. This ranks them
// by how connected they are to the files that already matched — which is how a
// function with no prose surface gets found: something retrievable calls it.
//
// "Personalized" means the random surfer restarts at the seed files (the current
// top hits) rather than uniformly, so centrality is measured relative to this
// query instead of globally. A globally central file (a util everything imports)
// would otherwise win every search.

/**
 * @param {Map<string, Map<string, number>>} edges  from -> (to -> weight)
 * @param {Map<string, number>} seeds  restart distribution, values need not sum to 1
 * @param {{alpha?: number, iterations?: number, tolerance?: number}} [opts]
 * @returns {Map<string, number>} score per node, max-normalised to [0, 1]
 */
export function personalizedPageRank(edges, seeds, opts = {}) {
  const alpha = opts.alpha ?? 0.85;
  const iterations = opts.iterations ?? 20;
  const tolerance = opts.tolerance ?? 1e-6;

  if (!seeds || seeds.size === 0) return new Map();

  // Node set: everything reachable plus every seed, so a seed with no edges
  // still scores (and still normalises sensibly).
  const nodes = new Set();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos.keys()) nodes.add(to);
  }
  for (const s of seeds.keys()) nodes.add(s);
  if (nodes.size === 0) return new Map();

  // Normalise the restart vector.
  let seedTotal = 0;
  for (const v of seeds.values()) seedTotal += v;
  if (seedTotal <= 0) return new Map();
  const restart = new Map();
  for (const [k, v] of seeds) restart.set(k, v / seedTotal);

  // Row-normalise outgoing edge weights once.
  const outbound = new Map();
  for (const [from, tos] of edges) {
    let total = 0;
    for (const w of tos.values()) total += w;
    if (total <= 0) continue;
    const normed = new Map();
    for (const [to, w] of tos) normed.set(to, w / total);
    outbound.set(from, normed);
  }

  let rank = new Map();
  for (const n of nodes) rank.set(n, restart.get(n) ?? 0);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    for (const n of nodes) next.set(n, (1 - alpha) * (restart.get(n) ?? 0));

    // Rank mass leaving dangling nodes returns to the seeds rather than being
    // lost, which would let total rank decay toward zero over iterations.
    let dangling = 0;
    for (const [n, r] of rank) {
      const out = outbound.get(n);
      if (!out || out.size === 0) { dangling += r; continue; }
      for (const [to, w] of out) next.set(to, (next.get(to) ?? 0) + alpha * r * w);
    }
    if (dangling > 0) {
      for (const [n, p] of restart) next.set(n, (next.get(n) ?? 0) + alpha * dangling * p);
    }

    let delta = 0;
    for (const n of nodes) delta += Math.abs((next.get(n) ?? 0) - (rank.get(n) ?? 0));
    rank = next;
    if (delta < tolerance) break;
  }

  // Max-normalise so callers can treat the output as a 0..1 boost factor
  // regardless of graph size.
  let max = 0;
  for (const v of rank.values()) if (v > max) max = v;
  if (max <= 0) return new Map();
  const out = new Map();
  for (const [n, v] of rank) if (v > 0) out.set(n, v / max);
  return out;
}

/**
 * Turn (file -> referenced names) and (name -> defining files) into a weighted
 * file graph. A file that references a name gets an edge to every file defining
 * it, split evenly — an ambiguous name is weaker evidence than a unique one.
 */
export function buildFileGraph(refsByFile, definitionsByName, damping = 'raw', maxDefiners = 0) {
  const edges = new Map();
  for (const [file, names] of refsByFile) {
    for (const name of names) {
      const targets = definitionsByName.get(name);
      if (!targets || targets.length === 0) continue;
      // A name defined in many files carries almost no information — `config`,
      // `router`, `handler`. Splitting weight 1/n does not go far enough: the
      // edges still exist, and every file referencing any of them drags rank
      // toward an arbitrary definer. Same intuition as an IDF cutoff.
      if (maxDefiners > 0 && targets.length > maxDefiners) continue;
      const weight = 1 / targets.length;
      for (const target of targets) {
        if (target === file) continue; // self-references carry no information
        let row = edges.get(file);
        if (!row) { row = new Map(); edges.set(file, row); }
        row.set(target, (row.get(target) ?? 0) + weight);
      }
    }
  }
  // Raw reference counts make dependency strength dominate relevance: a file
  // calling twelve helpers from one utility module points at it six times
  // harder than at the one function that actually answers the query. Damping
  // keeps the direction of the edge while flattening its magnitude.
  if (damping === 'raw') return edges;
  for (const row of edges.values()) {
    for (const [to, w] of row) {
      row.set(to, damping === 'binary' ? 1 : Math.sqrt(w));
    }
  }
  return edges;
}
