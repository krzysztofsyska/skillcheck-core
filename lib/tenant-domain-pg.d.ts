/** SC-020-B: the verifier closes its short-lived pool (adds to lib/competency-broker-pg.d.ts). */
declare module 'pg' {
  interface Pool {
    end(): Promise<void>;
  }
}
