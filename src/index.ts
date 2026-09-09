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
 * `resetMode: 'seam-region'` delegates the replacement to
 * `ctx.compaction.compactRegion` over the whole balanced surface.
 * `resetMode: 'handoff'` needs no compaction backend: it replaces the surface
 * itself with a template-assembled checkpoint and pays no summarization call —
 * design decision U1 option *a*, fed by the model-facing `notes` tool that
 * option *c* asks the model to call. A handoff window therefore never opens
 * with no task state, which is Codex's open issue #43335.
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
import { boundNotes, extractHandoff, NotesBuffer, readPriorCheckpointNotes } from './handoff.ts'
import type { ProjectionReader } from './handoff.ts'
import {
  assertReminderTemplate,
  renderHandoffCheckpoint,
  renderResetReminder,
  renderWindowNotice,
} from './notice.ts'
import { hasOpenCompaction, replaceSurfaceWithCheckpoint } from './replace.ts'
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
  /** Notes the model wrote for the next window; carried into the checkpoint. */
  readonly notes: NotesBuffer
  /** Whether the notes were seeded from a previous checkpoint after a resume. */
  notesSeeded: boolean
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
      notes: new NotesBuffer(config.maxNotes, config.maxNoteChars),
      notesSeeded: false,
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

    if (!runtime.notesSeeded) {
      runtime.notesSeeded = true
      if (runtime.notes.isEmpty) {
        const recovered = readPriorCheckpointNotes(agent.session)
        if (recovered.length > 0) runtime.notes.seed(boundNotes(recovered, config.maxRecoveredNoteChars))
      }
    }

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

  if (config.notesToolEnabled) {
    const tool = defineTool({
      name: config.notesToolName,
      description: 'Record a note that must survive into the next context window. '
        + 'Call this before the window resets; the notes are carried into the new window verbatim.',
      parameters: {
        note: { type: 'string', required: true, description: 'One self-contained note: a decision, a constraint, or the next concrete step.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', required: true },
            notes: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: (value as { message: string }).message },
        ],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) {
          return { message: 'Notes can only be recorded from an agent session.', notes: [] }
        }
        const runtime = runtimeFor(agent.session)
        const retained = runtime.notes.add(args.note)
        return {
          message: retained
            ? `Noted (${runtime.notes.list().length}/${config.maxNotes} notes retained for the next window).`
            : 'The note was empty or the notes budget is zero — nothing was recorded.',
          notes: [...runtime.notes.list()],
        }
      },
    })
    ctx.effect(() => ctx.tools.register(tool), 'context-window: notes tool')
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
    parts.push(renderResetReminder(
      config.resetReminderTemplate,
      budget.remainingTokens,
      config.notesToolEnabled ? config.notesToolName : undefined,
    ))
  }
  return parts.join('\n\n')
}

/**
 * Perform one reset at a pre-step boundary.
 *
 * The two modes build the replacement differently:
 *
 * - `seam-region` delegates to the mounted compaction backend over the whole
 *   balanced surface, so the backend owns the durable bracket, the checkpoint
 *   marker, and the shadow-price bookkeeping.
 * - `handoff` writes the surface replacement itself (see
 *   {@link writeCheckpoint}) and needs no `ctx.compaction` at all: it installs
 *   a template-assembled checkpoint as the fresh window's only message, with no
 *   summarization call. This is design decision U1 option *a* fed by the
 *   `notes` tool of option *c*, and it is the mode that avoids Codex's open
 *   issue #43335.
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

  if (hasOpenCompaction(session)) {
    logger.warn('a compaction transaction is open — the reset is deferred to the next boundary')
    runtime.resetRequested = true
    return
  }

  // The handoff must be assembled while the outgoing window is still on the
  // surface: the replacement below removes every node it reads.
  const handoff = config.resetMode === 'handoff'
    ? extractHandoff({
        session,
        from: { ordinal: runtime.window.snapshot().ordinal, id: runtime.window.snapshot().currentId },
        notes: runtime.notes.list(),
        stateOf: projectionReader(ctx),
        maxTodos: config.maxHandoffTodos,
        maxRequestChars: config.maxHandoffRequestChars,
      })
    : undefined

  if (handoff === undefined) {
    const compaction = ctx.get('compaction') as CompactionEngine | undefined
    if (compaction === undefined) {
      if (!runtime.warnedNoCompaction) {
        runtime.warnedNoCompaction = true
        logger.warn('no compaction backend in this scope — a reset request cannot be executed here')
      }
      return
    }
    try {
      await compaction.compactRegion(first, last, agent, signal)
    } catch (error) {
      logger.warn('compaction refused the reset: %s', String(error))
      return
    }
    advanceWindow(runtime)
    return
  }

  advanceWindow(runtime)

  const snapshot = runtime.window.snapshot()
  try {
    const text = renderHandoffCheckpoint({ ...handoff, toOrdinal: snapshot.ordinal, toId: snapshot.currentId })
    replaceSurfaceWithCheckpoint({
      session,
      text,
      shadowed: nodes,
      source: { plugin: name, section: `${name}:handoff` },
      meter: ctx.get('tokenMeter') as TokenMeter | undefined,
    })
  } catch (error) {
    logger.warn('the handoff checkpoint could not be written — the window keeps its history: %s', String(error))
    return
  }

  runtime.notes.clear()
  logger.info(
    'handoff: window %d -> %d, %d note(s), %d open todo(s)%s',
    snapshot.ordinal - 1,
    snapshot.ordinal,
    handoff.notes.length,
    handoff.todos.length,
    handoff.goal === undefined ? '' : ', goal carried',
  )
}

/**
 * Reset the per-window emission state after the surface was replaced.
 * @param runtime - the reset session's runtime state.
 */
function advanceWindow(runtime: SessionRuntime): void {
  runtime.window.startNext()
  runtime.throttle.reset()
  runtime.noticeSent = false
  runtime.reminderSent = false
}

/**
 * Resolve the optional session-projection reader.
 * @param ctx - plugin context.
 * @returns a reader, or `undefined` when no projection registry is mounted.
 */
function projectionReader(ctx: Context): ProjectionReader | undefined {
  const registry = ctx.get('sessionProjections') as
    | { stateOf?: (session: Session, key: string) => unknown }
    | undefined
  if (registry === undefined || typeof registry.stateOf !== 'function') return undefined
  return (session, key) => registry.stateOf?.(session, key)
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
