/**
 * Telegram-scoped `tele_ask_user` tool: same schema as `ask_user_question` but
 * routes human input through the bridge UI instead of `ctx.userQuestions`.
 *
 * @module telegram/tele-ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TelegramBridge } from './bridge.js'

interface ToolsLike {
  register(definition: unknown): () => void
  restrict(filter: { deny?: string[], allow?: string[] }): () => void
}

interface TeleAskUserQuestionArg {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: ReadonlyArray<{ readonly label: string, readonly description?: string }>
  readonly multi_select?: boolean
}

const DESCRIPTION = 'Ask the user a concise question in this Telegram chat when you need confirmation, '
  + 'a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id echoed in the answer. '
  + 'Use this tool instead of ask_user_question in Telegram sessions.'

/** Agent-scoped system prompt: channel context for Telegram-bound sessions. */
export const TELEGRAM_CHANNEL_SECTION = 'telegram:channel'

export const TELEGRAM_SESSION_HINT = [
  'This session is connected to the user through Telegram.',
  'When you need confirmation, a choice, or missing information from the user, call tele_ask_user.',
  'Do not use ask_user_question (unavailable in this session) or plain-text questions expecting a free-form reply.',
].join(' ')

interface SystemPromptLike {
  section(spec: { name: string, order: number, text: string }): () => void
}

/** Tell the model this agent runs over Telegram and which question tool to use. */
export function registerTelegramSessionHint(agentCtx: Context): void {
  const scoped = agentCtx as Context & { systemPrompt?: SystemPromptLike }
  const systemPrompt = scoped.systemPrompt ?? (agentCtx.get('systemPrompt') as SystemPromptLike | undefined)
  if (systemPrompt === undefined) return
  systemPrompt.section({
    name: TELEGRAM_CHANNEL_SECTION,
    order: 50,
    text: TELEGRAM_SESSION_HINT,
  })
}

/** Hide global `ask_user_question` and register `tele_ask_user` on one agent scope. */
export function wireTeleAskUserTool(agentCtx: Context, bridge: TelegramBridge): () => void {
  const tools = agentCtx.get('tools') as ToolsLike | undefined
  if (tools === undefined) {
    return () => {}
  }
  const disposers: Array<() => void> = []
  try {
    disposers.push(tools.restrict({ deny: ['ask_user_question'] }))
  } catch {
    // Global ask_user_question may be absent in minimal compositions.
  }
  disposers.push(tools.register({
    name: 'tele_ask_user',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', description: 'The specific question to ask the user.' },
              header: { type: 'string', description: 'Optional short heading.' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence explaining the tradeoff.' },
                  },
                  required: ['label'],
                },
              },
              multi_select: {
                type: 'boolean',
                description: 'Whether the user may select more than one option.',
              },
            },
            required: ['id', 'question'],
          },
        },
      },
      required: ['questions'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
              required: ['id', 'selected'],
            },
          },
        },
        required: ['answers'],
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { questions: TeleAskUserQuestionArg[] }, exec: { agent?: Agent, signal: AbortSignal }) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('tele_ask_user requires a calling agent')
      }
      const result = await bridge.askUserQuestion({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.options === undefined ? {} : { options: question.options }),
          ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
        })),
        agent,
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
      }
    },
  }))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
