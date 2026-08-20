---
name: semantic-search
description: "Code search for this repo — pick the right Beacon tool for the question: exact symbol lookup, reference tracing, file outline, or semantic search."
allowed-tools: [Bash, Read]
---

# Code Search (Beacon)

This repo has a Beacon index: semantic embeddings, BM25 keyword matching, and a
symbol reference graph. Beacon exposes **MCP tools you call directly** — prefer
them over shelling out.

## Pick the tool by what you are actually asking

| You want | Use | Cost |
|---|---|---|
| Where a known symbol is **defined** | `find_symbol(name)` | ~0.01 ms, exact |
| **Every call site** of a symbol | `find_references(name)` | ~0.01 ms, exhaustive |
| A file's **structure** before reading it | `outline(file)` | ~0.01 ms |
| Code matching a **concept** you can only describe | `search_code(query)` | ~200 ms, ranked |
| **Literal text** — regex, punctuation, exact case | `Grep` | — |

The first three are indexed SQL lookups. If you already know the name, do not
pay for a semantic search and get back a ranked top-10 for a question that has
one exact answer.

**`find_references` is exhaustive, `search_code` is a ranked sample.** For
"what breaks if I change this", only `find_references` actually answers it.

## search_code

```
search_code(query: "how are failed payments retried", top_k: 10, path: "src/billing/", mode: "hybrid")
```

- `mode: "hybrid"` (default) — embeddings + BM25 + reference graph
- `mode: "semantic"` — embeddings only
- `mode: "lexical"` — keyword only; no embedding model, much faster
- `path` — restrict to a repo-relative prefix

Results carry `file`, `lines`, `score`, and a `preview`. Read the file at those
line ranges for real context — the preview is a fragment, not the answer.

## When Beacon cannot help

`find_symbol` returning nothing means the symbol is not *indexed* — it may live
in a dependency, be constructed dynamically, or differ in case. Fall back to
`Grep`. Grep is also the right tool for text inside strings and comments, which
the reference extractor deliberately strips.

If tools report an empty symbol graph, the index predates symbol extraction —
run `/reindex`.

## Fallback CLI

If the MCP tools are unavailable:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/search.js "<query>" [--top-k N] [--path PREFIX] [--no-hybrid]
```

Multiple queries in one call share a single round-trip:
`search.js "auth flow" "session handling" "token refresh"`

## Grep interception

Grep is **not blocked**. A hook may add a note suggesting a Beacon tool when the
pattern looks like a concept or a bare identifier; grep still runs, and you
should keep it when you want literal matching. Set `intercept.mode` in
`.claude/beacon.json` to `"redirect"` to block grep instead, or `"off"` to
silence the hook.

## Workflow

1. Known name? → `find_symbol` / `find_references`
2. Only a description? → `search_code`
3. Read the top files at the reported line ranges
4. `outline` a large file before reading it whole
5. Cite `file:line`
