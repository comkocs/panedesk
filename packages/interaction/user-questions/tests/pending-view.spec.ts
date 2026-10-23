/** Pending queries observe interaction state without answering or waking agents. */
import { Context } from '@panedesk/cordis'
import { describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { Session, SessionId } from '@panedesk/dsh-session'
import { ToolCallId, createToolResultMessage } from '@panedesk/dsh-llm'
import UserQuestions, { type AskUserQuestionAnswer } from '../src/index.ts'

describe('pending question view', () => {
  it('reads timed open and continued questions from durable projection and distinguishes unavailable evidence', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestions)
    try {
      const session = Session.create(SessionId('window-a'))
      expect(ctx.userQuestions.pendingForSession(session)).toEqual({ available: false, blocking: [], timed: [] })
      await mountAgentLoopTestDependencies(ctx)
      const callId = ToolCallId('question-a')
      const questions = [{ id: 'choice', question: 'Continue?' }]
      session.append('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'model-a' },
        tools: [{ name: 'ask_user_question', description: 'Ask', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }] } })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) })
      expect(ctx.userQuestions.pendingForSession(session).timed).toEqual([{ callId, questions, state: 'open' }])
      session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false }) },
      { surfaceOp: 'append' })
      expect(ctx.userQuestions.pendingForSession(session).timed).toEqual([{ callId, questions, state: 'continued' }])
    } finally { await ctx.fiber.dispose() }
  })

  it('reports exact-session pending questions including plan review and clears them after settlement', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const driver = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(UserQuestions)
    try {
      const agent = await driver.create(SessionId('window-a'))
      const other = await driver.create(SessionId('window-b'))
      const answer = Promise.withResolvers<AskUserQuestionAnswer>()
      ctx.on('user-questions/request', () => answer.promise)
      const notifications: string[] = []
      ctx.on('user-questions/pending-changed', (payload) => { notifications.push(payload.sessionId) })
      const questions = [{ id: 'plan', question: 'Approve this plan?', detail: 'A neutral plan',
        options: [{ label: 'Approve' }], intent: { kind: 'plan-review' as const, approve: 'Approve' } }]
      const pending = ctx.userQuestions.ask({ agent, questions })
      const seq = agent.session.seq
      const view = ctx.userQuestions.pendingForSession(agent.session)
      expect(view).toEqual({ available: true, blocking: [{ questions }], timed: [] })
      expect(ctx.userQuestions.pendingForSession(other.session)).toEqual({ available: true, blocking: [], timed: [] })
      expect(view.blocking[0]!.questions).not.toBe(questions)
      expect(agent.session.seq).toBe(seq)
      expect(agent.status).toBe('idle')
      answer.resolve({ answers: [{ id: 'plan', selected: ['Approve'] }] })
      await pending
      expect(ctx.userQuestions.pendingForSession(agent.session)).toEqual({ available: true, blocking: [], timed: [] })
      expect(notifications).toEqual([agent.id, agent.id])
    } finally { await ctx.fiber.dispose() }
  })

  it('clears pending state on answerer failure without changing the original error', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const driver = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(UserQuestions)
    try {
      const agent = await driver.create(SessionId('window-a'))
      await expect(ctx.userQuestions.ask({ agent, questions: [{ id: 'choice', question: 'Choose?' }] }))
        .rejects.toMatchObject({ code: 'NO_PROVIDER' })
      expect(ctx.userQuestions.pendingForSession(agent.session).blocking).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})
