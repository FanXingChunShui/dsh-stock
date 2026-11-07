/**
 * dsh-stock-surf — A 股涨跌评估插件。
 *
 * 数据来自腾讯免费公开行情接口（实时快照 + 前复权日K），评分完全在本地
 * 计算：不写任何密钥，不上传任何数据，不发送任何用户输入。
 *
 * 插件同时提供两副面孔：
 *   - Web 面板：侧栏图标 + 主面板，手动看盘与自选股。
 *   - Agent 工具：`astock_evaluate` / `astock_quote` / `astock_search`，
 *     让模型在对话里直接评估。
 *
 * @module dsh-stock-surf
 */
import { Config } from './lib/config.js';
import { WatchlistStore } from './lib/watchlist.js';
import { createAstockRpc, CHANNEL } from './lib/rpc.js';
import { registerTools } from './lib/tools.js';
import { loadStockData, normalizeCode } from './lib/quote.js';
import { evaluateStock } from './lib/score.js';

/**
 * Load the sector feature lazily.
 *
 * The sector module is optional at mount time: a build or a partial install
 * without it must still serve the individual-stock tools and the price panel,
 * with the sector endpoints answering a readable failure instead of the whole
 * plugin failing to activate.
 *
 * @returns {Promise<object|undefined>} `{ list, rank }` or `undefined`.
 */
async function loadSectorFeature() {
  try {
    const data = await import('./lib/sector.js');
    const score = await import('./lib/sector-score.js');
    if (typeof data.fetchSectors !== 'function' || typeof score.evaluateSectors !== 'function') {
      return undefined;
    }
    return {
      list: (boardType, signal, options) => data.fetchSectors({ boardType, signal, ...(options ?? {}) }),
      rank: (items, options) => score.evaluateSectors(items, options),
    };
  } catch (error) {
    try {
      // eslint-disable-next-line no-console
      console.warn('astock: sector feature unavailable:', error instanceof Error ? error.message : String(error));
    } catch {
      /* logging must never break the plugin */
    }
    return undefined;
  }
}

export const name = 'astock';

/**
 * Nothing here is mandatory: the Web panel needs `connection`, the tools need
 * `tools`. A profile without one still loads the plugin and simply offers the
 * other half.
 */
export const inject = [];

export { Config };

/**
 * Read one config field that may be a volatile reference.
 *
 * @param {unknown} field - plain value or `{ get() }` reference.
 * @param {unknown} fallback - value used when the field is absent.
 * @returns {unknown} the committed value.
 */
function fieldValue(field, fallback) {
  if (field === undefined || field === null) return fallback;
  const get = field.get;
  if (typeof get === 'function') {
    const value = get();
    return value === undefined || value === null ? fallback : value;
  }
  return field;
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - owning Cordis plugin context.
 * @param {object} config - resolved plugin config (fields may be volatile references).
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = config ?? {};

  if (fieldValue(resolved.enabled, true) === false) {
    warn(ctx, 'disabled by configuration');
    return;
  }

  const store = new WatchlistStore({ ctx, config: resolved });

  // The sector feature resolves asynchronously; every consumer reads through
  // this slot so a late load is picked up without re-registering anything.
  /** @type {object|undefined} */
  let sectorFeature;
  const sectorReady = loadSectorFeature().then((feature) => {
    sectorFeature = feature;
    return feature;
  });

  /**
   * The sector feature as a stable facade.
   *
   * `list` and `rank` await the lazy import first, so the RPC channel and the
   * tools can be registered synchronously at mount and still serve the sector
   * endpoints once the module has loaded.
   */
  const sectors = {
    async list(boardType, signal, options) {
      const feature = sectorFeature ?? (await sectorReady);
      if (feature === undefined) throw new Error('astock: 板块模块未加载');
      return feature.list(boardType, signal, options);
    },
    async rank(items, options) {
      const feature = sectorFeature ?? (await sectorReady);
      if (feature === undefined) throw new Error('astock: 板块模块未加载');
      return feature.rank(items, options);
    },
  };

  /** Current bounded upstream timeout. */
  const timeoutMs = () => Number(fieldValue(resolved.timeoutMs, 8000)) || 8000;

  /** Current default bar count. */
  const defaultDays = () => Number(fieldValue(resolved.defaultDays, 320)) || 320;

  /**
   * Evaluate one code end to end, shared by the RPC channel and the tools.
   *
   * @param {string} code - raw or normalized code.
   * @param {number} [days] - bar count override.
   * @param {AbortSignal} [signal] - external cancellation.
   * @returns {Promise<object>} the evaluation.
   */
  const evaluate = async (code, days, signal) => {
    const normalized = normalizeCode(code);
    if (normalized === null) throw new Error(`astock: 无法识别的股票代码「${String(code ?? '')}」`);
    const limit = Math.max(30, Math.min(1200, Number(days) || defaultDays()));
    // 必须传 secid（含市场前缀）而不是裸 code：loadStockData 内部会再次
    // normalizeCode，裸代码（如美股 'NVDA'）会被判为非法而返回空数据。
    const loaded = await loadStockData(normalized.secid, { limit, timeoutMs: timeoutMs(), signal });
    if (loaded.quote === null && loaded.bars.length === 0) {
      throw new Error(`astock: 取不到 ${normalized.secid} 的行情数据（网络不可达或代码不存在）`);
    }
    const evaluation = evaluateStock({ quote: loaded.quote, bars: loaded.bars });
    if (Array.isArray(loaded.warnings) && loaded.warnings.length > 0) {
      const quality = evaluation.dataQuality ?? {
        bars: loaded.bars.length,
        hasQuote: loaded.quote !== null,
        stale: false,
        warnings: [],
      };
      quality.warnings = [...loaded.warnings, ...(quality.warnings ?? [])];
      evaluation.dataQuality = quality;
    }
    return evaluation;
  };

  // ── Web panel channel ────────────────────────────────────────────────────
  // `webServer` is part of the dependency set on purpose: the RPC channels are
  // served by the web carrier, so waiting for both keeps this registration from
  // running against a half-mounted connection. Every shipped plugin that serves
  // a browser channel injects the same pair.
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const connection = connectionCtx.connection;
    if (typeof connection?.rpc?.handle !== 'function') {
      warn(ctx, 'connection.rpc.handle is unavailable; the Web panel will report a missing channel');
      return;
    }
    const handler = createAstockRpc({
      config: {
        get timeoutMs() {
          return timeoutMs();
        },
        get defaultDays() {
          return defaultDays();
        },
        get indices() {
          return fieldValue(resolved.indices, undefined);
        },
      },
      readWatchlist: async () => store.read(),
      writeWatchlist: async (codes) => store.write(codes),
      evaluate,
      sectors,
    });
    // Prefer the connection's own `register(ctx, channel, handler)`, which binds
    // the channel to the supplied context (and therefore to `webServer`). Bare
    // `rpc.handle()` reads `webServer` off the *current* inject target and throws
    // `cannot get property "webServer" without inject` from a plugin fiber.
    const register = connection.register;
    let dispose;
    if (typeof register === 'function') {
      dispose = register.call(connection, connectionCtx, CHANNEL, handler);
    } else {
      dispose = connection.rpc.handle(CHANNEL, handler);
    }
    if (typeof dispose === 'function') {
      connectionCtx.effect(
        () => () => {
          Promise.resolve(dispose()).catch((error) => warn(ctx, error));
        },
        'astock: RPC channel',
      );
    }
  });

  // ── Agent tools ─────────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    if (fieldValue(resolved.tools, true) === false) return;
    toolCtx.effect(() => {
      const disposers = registerTools(toolCtx, {
        config: {
          get timeoutMs() {
            return timeoutMs();
          },
        },
        evaluate,
        sectors,
      });
      return () => {
        for (const dispose of disposers ?? []) {
          try {
            dispose();
          } catch (error) {
            warn(ctx, error);
          }
        }
      };
    }, 'astock: tools');
  });
}
