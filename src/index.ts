/**
 * dsh-context-window — Codex-style context window management for DSH.
 *
 * What this plugin does, and what it deliberately does not:
 *
 * - It measures the routed model's budget with `ctx.tokenMeter` plus the
 *   adapter-owned capacity, and injects the model-visible window notice
 *   (Codex's `<token_budget>` / `<context_window>` developer message) on window
 *   open and at the configured consumption thresholds.
 * - It registers a model-facing `new_context` tool whose call records a reset
 *   request; the reset itself happens at the next pre-step boundary, where the
 *   session surface is tool-pairing balanced. DSH's compaction seam forbids
 *   cutting through a live tool call, so this is the earliest legal point —
 *   and it is why the plugin does not reset inside the tool call.
 * - It owns `ctx.compaction` only when mounted in a scope that provides it. A
 *   host-plane mount cannot replace the agent preset's compaction backend
 *   (`isolate: { compaction: true }`); it then contributes the notice and the
 *   tool while `compaction-basic` keeps handling pressure.
 *
 * v0 status: the notice and budget accounting are complete and unit-tested.
 * `resetMode: 'handoff'` (write a checkpoint into the fresh window instead of
 * relying on the model to read notes — Codex open issue #43335) is declared and
 * validated but NOT implemented; `resetMode: 'seam-region'` delegates the
 * replacement to `ctx.compaction.compactRegion` over the whole balanced surface.
 *
 * @module dsh-context-window
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveBudget } from './budget.ts'
import type { BudgetSnapshot } from './budget.ts'
import { assertConfig, Config } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { NoticeThrottle, normalizeNoticeThresholds } from './emission.ts'
import { assertReminderTemplate, renderResetReminder, renderWindowNotice } from './notice.ts'
import { WindowState } from './window-state.ts'

/** Plugin name, also the `source.plugin` label of every injected notice. */
export const name = 'context-window'

/**
 * No hard service dependencies: the plugin resolves `tokenMeter`, `llm`,
 * `tools`, and `compaction` lazily through `ctx.get`, so a deployment that
 * mounts it without a token meter still boots (and reports the gap) instead of
 * failing the whole plugin tree.
 */
export const inject: string[] = []

export { Config }
export type { ConfigShape as ContextWindowConfig }

/** Per-session runtime state. */
interface SessionRuntime {
  readonly window: WindowState
  readonly throttle: NoticeThrottle
  /** Set by the `new_context` tool, consumed at the next pre-step. */
  resetRequested: boolean
  /** Whether a notice has been injected for the current window. */
  noticeSent: boolean
  /** Whether the pre-reset reminder has been injected for the current window. */
  reminderSent: boolean
  /** Diagnostics already reported once for this session. */
  warnedNoMeter: boolean
  warnedNoCompaction: boolean
}

/**
 * Install the plugin's listeners and tool.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - validated plugin configuration.
 * @throws when the configuration is invalid (fail-loud at load time).
 */
export function apply(ctx: Context, config: ConfigShape): void {
  assertConfig(config)
  assertReminderTemplate(config.resetReminderTemplate)
  const thresholds = normalizeNoticeThresholds(config.noticeThresholds)
  if (!config.enabled) return

  const logger = ctx.logger(name)
  const sessions = new Map<string, SessionRuntime>()

  const runtimeFor = (session: Session): SessionRuntime => {
    const existing = sessions.get(session.id)
    if (existing !== undefined) return existing
    const created: SessionRuntime = {
      window: new WindowState(),
      throttle: new NoticeThrottle(thresholds),
      resetRequested: false,
      noticeSent: false,
      reminderSent: false,
      warnedNoMeter: false,
      warnedNoCompaction: false,
    }
    sessions.set(session.id, created)
    return created
  }

  ctx.on('session/disposed', (session) => {
    sessions.delete(session.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision

    const { agent } = payload
    const runtime = runtimeFor(agent.session)

    if (runtime.resetRequested) {
      runtime.resetRequested = false
      await executeReset(ctx, config, runtime, agent, payload.signal)
      return decision
    }

    if (!config.noticeEnabled) return decision
    const notice = await buildNotice(ctx, config, runtime, agent, logger)
    if (notice === undefined) return decision

    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: notice }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name, text: notice }],
          },
        }),
      ],
    }
  }, { prepend: true })

  if (config.toolEnabled) {
    const tool = defineTool({
      name: config.toolName,
      description: 'Start a new context window.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: (value as { message: string }).message },
        ],
      },
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) {
          return { message: 'A new context window cannot be requested from this call.' }
        }
        const runtime = runtimeFor(agent.session)
        runtime.resetRequested = true
        return { message: 'A new context window will start without summarizing conversation history.' }
      },
    })
    ctx.effect(() => ctx.tools.register(tool), 'context-window: new_context tool')
  }

  logger.info('enabled — resetMode=%s, thresholds=%s', config.resetMode, thresholds.join('/'))
}

/**
 * Measure the routed session and decide whether a notice is due.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 * @param runtime - the session's runtime state.
 * @param agent - the agent whose session is measured.
 * @param logger - plugin logger for once-per-session diagnostics.
 * @returns the notice text, or `undefined` when nothing is due.
 */
async function buildNotice(
  ctx: Context,
  config: ConfigShape,
  runtime: SessionRuntime,
  agent: Agent,
  logger: ReturnType<Context['logger']>,
): Promise<string | undefined> {
  const meter = ctx.get('tokenMeter') as TokenMeter | undefined
  if (meter === undefined) {
    if (!runtime.warnedNoMeter) {
      runtime.warnedNoMeter = true
      logger.warn('no token meter mounted — the window notice stays disabled for this session')
    }
    return undefined
  }

  const session = agent.session
  const measurement = meter.measure(session)
  const contextWindow = await resolveContextWindow(ctx, agent)
  if (contextWindow === undefined) {
    if (!runtime.warnedNoMeter) {
      runtime.warnedNoMeter = true
      logger.warn('the routed model declares no context window — the window notice stays disabled for this session')
    }
    return undefined
  }

  const snapshot = runtime.window.snapshot()
  if (snapshot.prefillTokens === undefined) {
    if (measurement.baseline.kind === 'usage') runtime.window.observePrefill(measurement.baseline.tokens)
    else runtime.window.estimatePrefill(measurement.totalTokens)
  }

  const budget = resolveBudget({
    contextWindow,
    usedTokens: measurement.totalTokens,
    effectivePercent: config.effectiveContextWindowPercent,
    autoCompactRatio: config.autoCompactTokenLimitRatio,
    fallbackBufferTokens: config.fallbackBufferTokens,
    configuredLimit: config.configuredLimit,
    baselinePrefillTokens: config.bodyAfterPrefix ? runtime.window.snapshot().prefillTokens : undefined,
  })

  const consumedPercent = budget.usableTokens === 0
    ? 100
    : 100 - (budget.remainingTokens / budget.usableTokens) * 100
  const noticeDue = !runtime.noticeSent || runtime.throttle.claim(consumedPercent).length > 0
  const reminderDue = !runtime.reminderSent
    && config.reminderThresholdTokens > 0
    && budget.remainingTokens <= config.reminderThresholdTokens
  if (!noticeDue && !reminderDue) return undefined

  const parts: string[] = []
  if (noticeDue) {
    runtime.noticeSent = true
    parts.push(renderWindowNotice({
      ordinal: snapshot.ordinal,
      remainingTokens: budget.remainingTokens,
      firstId: snapshot.firstId,
      previousId: snapshot.previousId,
      currentId: snapshot.currentId,
    }))
  }
  if (reminderDue) {
    runtime.reminderSent = true
    parts.push(renderResetReminder(config.resetReminderTemplate, budget.remainingTokens))
  }
  return parts.join('\n\n')
}

/**
 * Perform one reset at a pre-step boundary.
 *
 * `seam-region` delegates to the mounted compaction backend over the whole
 * balanced surface: the backend owns the durable bracket, the checkpoint
 * marker, and the shadow-price bookkeeping, so this plugin never writes a
 * surface replacement itself. `handoff` is declared but unimplemented in v0 and
 * reports that instead of silently degrading to a bare reset.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 * @param runtime - the requesting session's runtime state.
 * @param agent - the agent whose surface is reset.
 * @param signal - the current turn's cancellation signal.
 */
async function executeReset(
  ctx: Context,
  config: ConfigShape,
  runtime: SessionRuntime,
  agent: Agent,
  signal: AbortSignal,
): Promise<void> {
  const logger = ctx.logger(name)
  if (config.resetMode === 'handoff') {
    logger.warn('resetMode "handoff" is not implemented in v0 — the request is dropped')
    return
  }

  const compaction = ctx.get('compaction') as CompactionEngine | undefined
  if (compaction === undefined) {
    if (!runtime.warnedNoCompaction) {
      runtime.warnedNoCompaction = true
      logger.warn('no compaction backend in this scope — a reset request cannot be executed here')
    }
    return
  }

  const session = agent.session
  const nodes = session.surface.nodes
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (first === undefined || last === undefined) return

  try {
    if (!toolPairingBalancedBefore(session, first) || !toolPairingBalancedAfter(session, last)) {
      logger.warn('the whole surface is not tool-pairing balanced — the reset is deferred to the next boundary')
      runtime.resetRequested = true
      return
    }
  } catch (error) {
    logger.warn('surface balance could not be established: %s', String(error))
    return
  }

  await compaction.compactRegion(first, last, agent, signal)
  runtime.window.startNext()
  runtime.throttle.reset()
  runtime.noticeSent = false
  runtime.reminderSent = false
}

/**
 * Resolve the routed model's capacity.
 * @param ctx - plugin context.
 * @param agent - the agent whose route is resolved.
 * @returns the capacity in tokens, or `undefined` when the route declares none.
 */
async function resolveContextWindow(ctx: Context, agent: Agent): Promise<number | undefined> {
  const { provider, model } = agent.options
  if (provider === undefined || model === undefined) return undefined
  const info = await ctx.llm.resolveModelInfo(provider, model)
  const contextWindow = info.context?.contextWindow
  return typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined
}

/** One budget snapshot, re-exported for consumers that render their own UI. */
export type { BudgetSnapshot }
export { resolveBudget }
