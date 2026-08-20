<p align="center">
  <img src="images/beacon.png" alt="Beacon" width="180">
</p>

<h1 align="center">Beacon</h1>

<p align="center">
  <strong>Turn Claude Code into Cursor.</strong><br>
  Semantic code search that understands your codebase — find code by meaning, not just string matching.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#usage">Usage</a> · <a href="#embedding-models">Models</a> · <a href="#commands">Commands</a> · <a href="#configuration">Config</a> · <a href="EXAMPLES.md">Examples</a>
</p>

---

<p align="center">
  <img src="images/benchmark.png" alt="Benchmark: 98.3% accuracy at 101ms" width="700">
</p>

<p align="center">
  <strong>98.3% accuracy · 5x faster than grep</strong><br>
  <sub>Author's 20-query benchmark on one codebase. Numbers depend heavily on corpus and query style —<br>
  measure on your own repo before relying on them. See <a href="#retrieval-quality">Retrieval quality</a>.</sub>
</p>

---

## Quick Start

### 1. Install Ollama (local embeddings, free)

```bash
brew install ollama
ollama serve &
ollama pull qwen3-embedding:0.6b
```

### 2. Install the Beacon plugin

```bash
claude plugin marketplace add sagarmk/beacon-plugin
claude plugin install beacon@beacon-plugin
```

### 3. Start Claude Code

```bash
claude
```

That's it. On first session start, Beacon will:
1. **Install npm dependencies automatically** (native modules like `better-sqlite3` — takes a few seconds)
2. **Index your codebase** in the background

No `npm install`, no manual setup. Just install and go.

## Usage

After installing, Beacon indexes automatically on session start. Here's the essentials:

### Force a full re-index

```
> /reindex
```

Deletes existing embeddings and rebuilds from scratch — useful after switching models or if the index gets stale.

### Check index health

```
> /index
```

```
Beacon Index

● ● ● ● ●    qwen3-embedding:0.6b · Ollama (local)
● ● ● ● ●    1024 dims · 3.8 MB
● ● ● ● ●
● ● ● ● ●    Coverage: 100% (38/38 files)

              Indexed by extension
              ● .js  25 files
              ● .md  13 files

              Statistics
              Indexed files    38
              Total chunks     109
              Avg chunks/file  2.9
              Last sync        2 minutes ago
```

For a quick numeric summary:

```
> /index-status
```

```json
{
  "files_indexed": 38,
  "total_chunks": 114,
  "last_sync": "2026-03-01T04:30:21.453Z",
  "embedding_model": "qwen3-embedding:0.6b",
  "embedding_endpoint": "http://localhost:11434/v1"
}
```

### Search your codebase

```
> /search-code "authentication flow"
```

```json
[
  {
    "file": "src/middleware/auth.ts",
    "lines": "12-45",
    "similarity": "0.82",
    "score": "0.74",
    "preview": "export async function verifyAuth(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  ..."
  },
  {
    "file": "src/routes/login.ts",
    "lines": "8-32",
    "similarity": "0.78",
    "score": "0.65",
    "preview": "router.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  ..."
  }
]
```

Hybrid search combines **semantic similarity** (understands meaning), **BM25 keyword matching**, **identifier boosting**, and a **symbol reference graph** — so searching "auth flow" finds code about authentication even if it never uses the word "auth".

Options: `--top-k N` (results count), `--threshold F` (min score), `--path <dir>` (scope to directory), `--no-hybrid` (pure vector search).

---

## Tools Claude uses

Beacon ships an MCP server, so Claude picks the right tool for the question
instead of grepping and hoping. Three of these never run the embedding model at
all — they are indexed lookups over the symbol tables.

| Tool | For | Cost |
|---|---|---|
| `find_symbol(name)` | Where a symbol is **defined** | ~0.01 ms, exact |
| `find_references(name)` | **Every call site** — exhaustive, not a ranked sample | ~0.01 ms |
| `outline(file)` | A file's symbols with line numbers | ~0.01 ms |
| `search_code(query)` | Code matching a description you can't name | ~200 ms, ranked |
| `index_status()` | Index health, when results look stale | ~0.01 ms |

`find_references` is the one worth knowing about: it is exhaustive over indexed
files, so it is the only correct tool for *"what breaks if I change this"*.
Ranked search returns a sample and will quietly miss call sites.

`search_code` also takes `mode: "lexical"` (keyword only, skips the embedding
model entirely) and `mode: "semantic"` (embeddings only).

**Grep is still the right tool** for literal text, regex, case-sensitive
matches, and anything outside the index — `node_modules`, `dist`, lockfiles,
`.env`. Beacon leaves those alone.

---

## Retrieval quality

The symbol graph exists because embeddings are blind to structure. A function
with no doc comment has almost no natural-language surface, so no phrasing
reaches it — but whatever calls it usually is retrievable, one reference edge
away. Personalized PageRank seeded on the current best matches walks that edge.

Measured on this repo, 12 natural-language queries with no lexical overlap with
their targets:

| | top-1 | MRR |
|---|---|---|
| Vector only | 5/12 | 0.552 |
| Hybrid, no graph | 7/12 | 0.722 |
| **Hybrid + symbol graph** | **9/12** | **0.813** |

Two caveats worth stating plainly:

- **Twelve queries on one repo is a small sample.** Treat the direction as
  meaningful and the exact numbers as noisy.
- **Hybrid weights are a deliberate compromise.** Dropping BM25 scores better on
  prose queries (0.813) and much worse on exact-identifier lookup (0.563 vs
  0.988 on a 40-query benchmark). The shipped `.4 / .3 / .3` split is the only
  configuration that holds up on both.

Run `search.js` with `search.hybrid.debug: true` in `.claude/beacon.json` to see
every scoring component per result.

---

## Embedding Models

Beacon runs on **open-source models by default** — no API keys, no cloud costs, fully local via [Ollama](https://ollama.com).

| Model | Dims | Speed (M2, measured) | Best for |
|-------|------|----------------------|----------|
| **qwen3-embedding:0.6b** (default) | 1024 | 24 chunks/s | Strong code retrieval, instruction-aware queries |
| **nomic-embed-text** | 768 | 43 chunks/s | Fastest indexing; set `dimensions: 768` |
| **qwen3-embedding:4b** | 1024 | 4 chunks/s | Highest quality, ~10x slower to index |
| **all-minilm** | 384 | very fast | Lightweight, low resource usage |

Throughput measured warm on an M2/16GB — a cold model load makes the first run
look far slower than steady state.

**Changing model or dimensions invalidates the index.** Beacon detects the
mismatch, refuses to search rather than returning nonsense, and tells you to run
`/reindex`.

To switch models, pull with Ollama and update your config:

```bash
ollama pull mxbai-embed-large
```

```json
// .claude/beacon.json
{
  "embedding": {
    "model": "mxbai-embed-large",
    "dimensions": 1024,
    "query_prefix": ""
  }
}
```

Then run `/reindex` to rebuild with the new model.

### Cloud Providers

For cloud-hosted embeddings, create `.claude/beacon.json` in your repo:

<details>
<summary><strong>OpenAI</strong></summary>

```bash
export OPENAI_API_KEY="sk-..."
```

```json
{
  "embedding": {
    "api_base": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY",
    "dimensions": 1536,
    "batch_size": 100,
    "query_prefix": ""
  }
}
```

</details>

<details>
<summary><strong>Voyage AI</strong></summary>

```bash
export VOYAGE_API_KEY="pa-..."
```

```json
{
  "embedding": {
    "api_base": "https://api.voyageai.com/v1",
    "model": "voyage-code-3",
    "api_key_env": "VOYAGE_API_KEY",
    "dimensions": 1024,
    "batch_size": 50,
    "query_prefix": ""
  }
}
```

</details>

<details>
<summary><strong>LiteLLM proxy</strong> (Vertex AI, Bedrock, Azure, etc.)</summary>

```bash
pip install litellm
litellm --model vertex_ai/text-embedding-004 --port 4000
```

```json
{
  "embedding": {
    "api_base": "http://localhost:4000/v1",
    "model": "vertex_ai/text-embedding-004",
    "api_key_env": "LITELLM_API_KEY",
    "dimensions": 1024,
    "batch_size": 50,
    "query_prefix": ""
  }
}
```

</details>

<details>
<summary><strong>Custom endpoint</strong></summary>

Any server implementing the OpenAI `/v1/embeddings` API will work. Set `api_base`, `model`, `dimensions`, and optionally `api_key_env` in `.claude/beacon.json`.

</details>

## Commands

Beacon indexes your codebase automatically on session start and re-embeds files as you edit — no manual steps needed.

#### Search

| Command | Description |
|---------|-------------|
| `/search-code` | Hybrid code search — semantic + keyword + BM25 matching. Supports `--path <dir>` to scope results |

#### Index

| Command | Description |
|---------|-------------|
| `/index` | Visual overview — files, chunks, coverage, provider |
| `/index-status` | Quick health check — file count, chunk count, last sync |
| `/reindex` | Force full re-index from scratch |
| `/run-indexer` | Manually trigger indexing |
| `/terminate-indexer` | Kill a running sync process |

#### Config

| Command | Description |
|---------|-------------|
| `/config` | View and modify Beacon configuration |
| `/blacklist` | Prevent indexing of specific directories |
| `/whitelist` | Allow indexing in otherwise-blacklisted directories |

Beacon also provides a **code-explorer** agent and a **semantic-search** skill that Claude can invoke automatically.

<details>
<summary><strong>Why Beacon?</strong></summary>

- **Understands your questions** — ask "where is the auth flow?" and get `lib/auth.ts`, not every file containing "auth"
- **Query expansion** — searches for "auth" automatically find code mentioning "authentication", "authorize", and "login"
- **Stays in sync automatically** — hooks handle full index, incremental re-embedding on edits, and garbage collection
- **Resilient** — retries with backoff on transient failures, auto-recovers from DB corruption, debounces GC
- **Works with any embedding provider** — Ollama (local/free), OpenAI, Voyage AI, LiteLLM, or any OpenAI-compatible API
- **Gives Claude better context** — MCP tools it selects itself, slash commands, a code-explorer agent, and a search-redirect hook

</details>

<details>
<summary><strong>How It Works</strong></summary>

Beacon uses Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to stay in sync with your codebase:

| Hook | Trigger | What it does |
|------|---------|-------------|
| **SessionStart** | Every session | Ensures npm deps are installed (first run only), then full index or diff-based catch-up |
| **PostToolUse** | `Write`, `Edit`, `MultiEdit` | Re-embeds the changed file |
| **PostToolUse** | `Bash` | Garbage collects embeddings for deleted files |
| **PreCompact** | Before context compaction | Injects index status so search capability survives compaction |
| **PreToolUse** | `Grep`, `Bash` | Redirects a codebase search to the matching Beacon tool. Covers shell `grep`/`rg` too, since that is what agents actually run. Skips regex, literals, and anything outside the index. |

</details>

<details>
<summary><strong>Configuration</strong></summary>

Default configuration (`config/beacon.default.json`):

```json
{
  "embedding": {
    "api_base": "http://localhost:11434/v1",
    "model": "qwen3-embedding:0.6b",
    "api_key_env": "",
    "dimensions": 1024,
    "batch_size": 10,
    "query_prefix": "Instruct: Given a code search query, retrieve the code that answers it\nQuery: ",
    "document_prefix": ""
  },
  "chunking": {
    "strategy": "hybrid",
    "max_tokens": 512,
    "overlap_tokens": 50
  },
  "indexing": {
    "include": ["**/*.ts", "**/*.tsx", "**/*.js", "..."],
    "exclude": ["node_modules/**", "dist/**", "..."],
    "max_file_size_kb": 500,
    "auto_index": true,
    "max_files": 10000,
    "concurrency": 4
  },
  "search": {
    "top_k": 10,
    "similarity_threshold": 0.35,
    "hybrid": {
      "enabled": true,
      "weight_vector": 0.4,
      "weight_bm25": 0.3,
      "weight_rrf": 0.3,
      "doc_penalty": 0.5,
      "identifier_boost": 1.5,
      "debug": false
    }
  },
  "storage": {
    "path": ".claude/.beacon"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `embedding.api_base` | `http://localhost:11434/v1` | Embedding API endpoint |
| `embedding.model` | `qwen3-embedding:0.6b` | Embedding model name |
| `embedding.dimensions` | `1024` | Vector dimensions (must match model) |
| `embedding.query_prefix` | qwen3 instruct prefix | Prepended to queries only |
| `embedding.document_prefix` | `""` | Prepended to indexed documents only |
| `indexing.include` | Common code patterns | Glob patterns for files to index |
| `indexing.exclude` | `node_modules`, `dist`, etc. | Glob patterns to skip |
| `indexing.max_file_size_kb` | `500` | Skip files larger than this |
| `indexing.auto_index` | `true` | Auto-index on session start |
| `indexing.concurrency` | `4` | Number of files to index in parallel |
| `search.top_k` | `10` | Max results per query |
| `search.similarity_threshold` | `0.35` | Minimum similarity score |
| `search.hybrid.enabled` | `true` | Enable hybrid search (set `false` for pure vector) |
| `search.hybrid.weight_graph` | `1.0` | Symbol-graph boost. `0` disables the graph signal |
| `intercept.mode` | `redirect` | `redirect` blocks a search and names the right tool, `advise` only suggests, `off` disables |

#### Per-repo overrides

Create `.claude/beacon.json` in any repo to override defaults. Values are deep-merged with the default config:

```json
{
  "embedding": {
    "api_base": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY",
    "dimensions": 1536
  },
  "indexing": {
    "include": ["**/*.py"],
    "max_files": 5000
  }
}
```

#### Storage

Beacon stores its SQLite database at `.claude/.beacon/embeddings.db` (configurable via `storage.path`). This file is auto-generated and safe to delete — run `/reindex` to rebuild. The database uses [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search and FTS5 for keyword matching.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### What if Ollama is down?

Beacon degrades gracefully when the embedding server is unreachable — it never blocks your session. Embedding requests automatically retry with backoff (1s, 4s) before giving up.

| Scenario | Behavior |
|----------|----------|
| **Session start** | Sync is skipped, error is logged, session continues normally |
| **Search** | Falls back to keyword-only (BM25) search — still returns results |
| **File edits** | Re-embedding fails silently, old embeddings are preserved |
| **Status commands** | Work normally (DB-only, no Ollama needed) |
| **DB corruption** | Auto-detected and rebuilt on next sync |

Start Ollama at any time and run `/run-indexer` to catch up.

### Manual indexing

| Command | What it does |
|---------|-------------|
| `/run-indexer` | Manually trigger indexing — useful when `auto_index` is off or after starting Ollama late |
| `/reindex` | Force a full re-index from scratch (deletes existing embeddings first) |
| `/terminate-indexer` | Kill a stuck sync process and clean up lock state |

### Checking index health

Run `/index` for a visual overview with a coverage bar, file list, and provider info. For a quick numeric summary, use `/index-status` — it shows file count, chunk count, and last sync time.

Things to look for:
- **Low coverage %** — files may be excluded by glob patterns or exceeding `max_file_size_kb`
- **Sync status errors** — usually means the embedding server was unreachable during the last sync
- **Stale sync warnings** — the index hasn't been updated recently; run `/run-indexer` to refresh

### Verifying search

Run `/search-code` with a test query to confirm search is working. If results include `"FTS-only"` in debug output, the embedding server is unreachable — search still works but without semantic matching (keyword/BM25 only).

</details>

## Examples

See [EXAMPLES.md](EXAMPLES.md) for real-world use cases — intent-based search, codebase navigation, identifier tracking, and auto-sync — each with concrete before/after comparisons.

## License

[MIT](LICENSE)
