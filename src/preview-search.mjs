import { stripTerminalAnsi, terminalColumns } from "./terminal-ui.mjs";

export const MAX_SEARCH_QUERY_SCALARS = 256;
export const MAX_SEARCH_CACHE_BYTES = 8 * 1024 * 1024;

function candidateBytes(candidates) {
  return candidates.length * 16;
}

export class PreviewSearchIndex {
  constructor(lines = [], { maxCacheBytes = MAX_SEARCH_CACHE_BYTES } = {}) {
    this.maxCacheBytes = maxCacheBytes;
    this.reset(lines);
  }

  reset(lines = []) {
    this.normalized = lines.map((line) => stripTerminalAnsi(line).toLocaleLowerCase());
    this.prefixes = new Map();
    this.cacheBytes = 0;
    this.operations = { normalizations: lines.length, examined: 0, recomputations: 0 };
  }

  clampQuery(value) {
    return [...String(value)].slice(0, MAX_SEARCH_QUERY_SCALARS).join("");
  }

  #remember(query, candidates) {
    const bytes = candidateBytes(candidates);
    if (bytes > this.maxCacheBytes) return;
    if (this.prefixes.has(query)) this.cacheBytes -= candidateBytes(this.prefixes.get(query));
    while (this.cacheBytes + bytes > this.maxCacheBytes && this.prefixes.size) {
      const oldest = this.prefixes.keys().next().value;
      this.cacheBytes -= candidateBytes(this.prefixes.get(oldest));
      this.prefixes.delete(oldest);
    }
    this.prefixes.set(query, candidates);
    this.cacheBytes += bytes;
  }

  matches(rawQuery) {
    const query = this.clampQuery(rawQuery).toLocaleLowerCase();
    if (!query) return [];
    const cached = this.prefixes.get(query);
    if (cached) return this.#positions(query, cached);
    const scalars = [...query];
    let prefix = "";
    let candidates = this.normalized.map((_line, row) => row);
    for (const scalar of scalars) {
      prefix += scalar;
      const existing = this.prefixes.get(prefix);
      if (existing) {
        candidates = existing;
        continue;
      }
      this.operations.examined += candidates.length;
      this.operations.recomputations += 1;
      candidates = candidates.filter((row) => this.normalized[row].includes(prefix));
      this.#remember(prefix, candidates);
    }
    return this.#positions(query, candidates);
  }

  #positions(query, candidates) {
    return candidates.map((row) => {
      const index = this.normalized[row].indexOf(query);
      return { row, column: terminalColumns(this.normalized[row].slice(0, index)) };
    });
  }
}
