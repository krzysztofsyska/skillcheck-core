/** Minimal runtime pg types scoped to the B3 adapter (no extra global types). */
declare module 'pg' {
  export interface PoolClient {
    query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(destroy?: boolean | Error): void;
  }
  export class Pool {
    constructor(config: {
      connectionString: string;
      ssl: { rejectUnauthorized: boolean };
      max: number;
      maxUses: number;
      connectionTimeoutMillis: number;
      idleTimeoutMillis: number;
      allowExitOnIdle: boolean;
      options: string;
    });
    waitingCount: number;
    connect(): Promise<PoolClient>;
  }
}
