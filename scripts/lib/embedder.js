function batchArray(array, size) {
  const batches = [];
  for (let i = 0; i < array.length; i += size) {
    batches.push(array.slice(i, i + size));
  }
  return batches;
}

export class Embedder {
  constructor(config) {
    this.apiBase = config.embedding.api_base;
    this.model = config.embedding.model;
    const envKey = config.embedding.api_key_env;
    this.apiKey = envKey ? (process.env[envKey] || '') : '';
    if (envKey && !process.env[envKey]) {
      console.warn(`Beacon: api_key_env="${envKey}" is set but the env var is not defined.`);
    }
    this.dimensions = config.embedding.dimensions;
    this.batchSize = config.embedding.batch_size;
    // Asymmetric models embed a question and a passage differently and need to
    // be told which is which. nomic-embed-text wants "search_query: " on one
    // side and "search_document: " on the other; Qwen3 puts an instruction on
    // the query only. Getting this wrong lands queries and documents in
    // mismatched subspaces and quietly costs recall on every search.
    this.queryPrefix = config.embedding.query_prefix || '';
    this.documentPrefix = config.embedding.document_prefix || '';
  }

  // Raw — no prefix. Used internally and for health checks.
  async _embed(texts) {
    const batches = batchArray(texts, this.batchSize);
    const embeddings = [];

    for (const batch of batches) {
      const data = await this._fetchWithRetry(batch);
      embeddings.push(...data.data.map(d => d.embedding));
    }

    return embeddings;
  }

  // Indexed side.
  async embedDocuments(texts) {
    return this._embed(this.documentPrefix ? texts.map(t => this.documentPrefix + t) : texts);
  }

  // Search side.
  async embedQueries(queries) {
    return this._embed(this.queryPrefix ? queries.map(q => this.queryPrefix + q) : queries);
  }

  async _fetchWithRetry(batch, retries = 2, backoffMs = 1000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.apiBase}/embeddings`, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
          },
          body: JSON.stringify({
            model: this.model,
            input: batch,
            dimensions: this.dimensions
          })
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Embedding API error ${response.status}: ${text}`);
        }

        return await response.json();
      } catch (err) {
        if (attempt < retries) {
          const delay = backoffMs * Math.pow(4, attempt); // 1s, 4s
          console.warn(`Beacon: embedding request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${err.message}`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  }

  async embedQuery(query) {
    const [embedding] = await this.embedQueries([query]);
    return embedding;
  }

  async ping() {
    try {
      await this._embed(['test']);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
