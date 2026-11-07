/**
 * Watchlist store for dsh-stock-surf.
 *
 * The list lives in this plugin entry's volatile `watchlist` config so the Web
 * panel can edit it without remounting the plugin. Writes go through the
 * profile configuration editor, so the list survives a restart.
 *
 * @module dsh-stock-surf/watchlist
 */
import { normalizeCode } from './quote.js';

/** Plugin package name as it appears in a profile patch entry. */
const PLUGIN_NAME = 'dsh-stock-surf';

/** Upper bound on saved codes. */
const MAX_CODES = 30;

/**
 * Normalize a candidate list into de-duplicated plain codes.
 *
 * @param {unknown} input - candidate list.
 * @returns {string[]} normalized codes, order preserved.
 */
export function normalizeWatchlist(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const normalized = normalizeCode(raw);
    if (normalized === null || seen.has(normalized.secid)) continue;
    seen.add(normalized.secid);
    out.push(normalized.code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

/** Read/write access to the committed watchlist. */
export class WatchlistStore {
  /** @type {object} */
  #ctx;

  /** Resolved plugin config whose `watchlist` field is a volatile reference. */
  #config;

  /** Serializes profile writes. */
  #writes = Promise.resolve();

  /**
   * @param {{ ctx: object, config: { watchlist?: { get: () => string[] } } }} options - owner and config.
   */
  constructor({ ctx, config } = {}) {
    if (ctx === null || typeof ctx !== 'object') {
      throw new TypeError('dsh-stock-surf: WatchlistStore requires the plugin ctx');
    }
    this.#ctx = ctx;
    this.#config = config ?? {};
  }

  /** Current committed list. */
  read() {
    const get = this.#config.watchlist?.get;
    const value = typeof get === 'function' ? get() : this.#config.watchlist;
    return normalizeWatchlist(value);
  }

  /** Locate this plugin's profile entry. */
  #entry(editor) {
    const entries = editor.entries();
    if (!Array.isArray(entries)) return undefined;
    const matches = entries.filter((entry) => entry?.options?.name === PLUGIN_NAME);
    if (matches.length === 0) return undefined;
    const own = this.#ctx.fiber?.entry;
    const owned = own === undefined ? undefined : matches.find((entry) => entry === own);
    if (owned !== undefined) return owned;
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Serialize one write operation after every earlier write. */
  #enqueue(task) {
    const run = this.#writes.then(task);
    this.#writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Replace the saved list.
   *
   * Falls back to the in-memory volatile reference when the configuration
   * editor is unavailable, so the panel still works within this process.
   *
   * @param {unknown} input - candidate list.
   * @returns {Promise<string[]>} the committed list.
   */
  async write(input) {
    const next = normalizeWatchlist(input);
    return this.#enqueue(async () => {
      const editor = this.#ctx.get?.('configEditor');
      const entry = editor !== undefined && editor !== null && typeof editor.entries === 'function'
        ? this.#entry(editor)
        : undefined;
      if (entry === undefined) {
        // No persisted entry: keep the list in memory for this process only.
        if (this.#config.watchlist !== undefined && typeof this.#config.watchlist === 'object') {
          this.#config.watchlist.set?.(next);
        }
        return next;
      }
      await editor.edit(entry, (raw) => ({ ...raw, watchlist: next }));
      return next;
    });
  }
}
