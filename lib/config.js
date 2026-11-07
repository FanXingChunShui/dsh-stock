/**
 * Plugin configuration for dsh-stock-surf.
 *
 * `watchlist` is volatile: the Web panel saves it in place, so the running
 * plugin sees the new list without remounting. Consumers read the committed
 * value with `config.watchlist.get()`.
 *
 * @module dsh-stock-surf/config
 */
import z from '@deepseek-ai/schemastery';

/** Codes the plugin starts with before the user edits the list. */
export const DEFAULT_WATCHLIST = Object.freeze(['600519', '000001', '300750']);

/** Indices shown in the panel header, in display order. */
export const DEFAULT_INDICES = Object.freeze(['sh000001', 'sz399001', 'sz399006']);

/** Plugin configuration. */
export const Config = z.object({
  /** Master switch for the Web panel and the Agent tools. */
  enabled: z.boolean().default(true),
  /** Daily bars requested per evaluation; 320 covers MA60 plus a full year. */
  defaultDays: z.natural().min(30).max(1200).default(320),
  /** Bound on one upstream HTTP request, in milliseconds. */
  timeoutMs: z.natural().min(1000).max(60000).default(8000),
  /** Whether the model-facing tools are registered. */
  tools: z.boolean().default(true),
  /** Indices rendered in the panel header. */
  indices: z.array(String).default([...DEFAULT_INDICES]),
  /** Saved codes, edited from the Web panel. */
  watchlist: z.array(String).default([...DEFAULT_WATCHLIST]).volatile(),
});
