import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Minimal D1Database implementation over node:sqlite, with all migrations
// applied, so tests exercise the real schema and SQL. rows_written is
// approximated by the number of changed rows.

type Param = string | number | null;

class Statement {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = []
  ) {}

  bind(...params: Param[]) {
    return new Statement(this.db, this.sql, params);
  }

  async all<T>() {
    return this.allSync<T>();
  }

  allSync<T>() {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length === 0) {
      const { changes } = stmt.run(...this.params);
      return { results: [] as T[], success: true, meta: { rows_written: Number(changes) } };
    }
    const rows = stmt.all(...this.params).map((r) => ({ ...r }));
    return { results: rows as T[], success: true, meta: { rows_written: 0 } };
  }

  async first<T>(column?: string) {
    const row = this.allSync<Record<string, unknown>>().results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run() {
    return this.allSync();
  }
}

export function createTestD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const db = {
    sqlite,
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.allSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return db as unknown as D1Database & { sqlite: DatabaseSync };
}
