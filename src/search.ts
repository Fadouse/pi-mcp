import MiniSearch from "minisearch";
import type { McpToolRecord } from "./types.js";

interface SearchDocument {
  id: string;
  name: string;
  server: string;
  serverDescription: string;
  description: string;
  schema: string;
}

export class McpToolSearchIndex {
  private records = new Map<string, McpToolRecord>();
  private index = createIndex();

  rebuild(records: Iterable<McpToolRecord>): void {
    this.records = new Map();
    this.index = createIndex();
    const documents: SearchDocument[] = [];
    for (const record of records) {
      this.records.set(record.id, record);
      documents.push({
        id: record.id,
        name: `${record.piName} ${record.remoteName} ${record.remoteName.replace(/[_-]+/g, " ")}`,
        server: `${record.serverName} ${record.serverName.replace(/[_-]+/g, " ")}`,
        serverDescription: record.serverDescription ?? "",
        description: record.description,
        schema: record.searchText,
      });
    }
    this.index.addAll(documents);
  }

  search(query: string, limit: number): McpToolRecord[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const results = this.index.search(trimmed, {
      boost: { name: 5, server: 2.5, serverDescription: 2, description: 2, schema: 1 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: "OR",
    });
    return results
      .slice(0, Math.max(1, limit))
      .map((result) => this.records.get(String(result.id)))
      .filter((record): record is McpToolRecord => record !== undefined);
  }
}

function createIndex(): MiniSearch<SearchDocument> {
  return new MiniSearch<SearchDocument>({
    fields: ["name", "server", "serverDescription", "description", "schema"],
    storeFields: [],
    processTerm: (term) => term.toLowerCase(),
  });
}
