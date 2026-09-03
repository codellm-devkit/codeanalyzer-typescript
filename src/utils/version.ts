/**
 * Analyzer version. Bump in lockstep with package.json. Stamped into the cache so that upgrading
 * the analyzer invalidates stale per-file Modules (whose source is unchanged but whose extracted
 * shape may differ across analyzer versions).
 */
export const ANALYZER_VERSION = "1.2.0";
