import assert from 'node:assert/strict'
import test from 'node:test'

import { createRenderer, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { useChatStreamHandler } from './useChatStreamHandler.ts'

/**
 * Regression tests for agent answer event seeding (issue #3383).
 *
 * Each ReAct round streams its answer under a fresh event_id. When a new
 * answer event arrives while earlier rounds' answers are still live (no
 * tool_call supersede in between), the new event must NOT inherit their
 * text; it must only catch up content written before the first answer
 * event existed.
 */

function setup() {
  const messagesList = reactive<Record<string, unknown>[]>([])
  const currentAssistantMessageId = ref('')

  const i18n = createI18n({ legacy: false, messages: {} })
  const renderer = createRenderer<Record<string, unknown>, Record<string, unknown>>({
    patchProp() {},
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    parentNode: () => null,
    nextSibling: () => null,
  })
  let handler!: ReturnType<typeof useChatStreamHandler>
  const app = renderer.createApp({
    setup() {
      handler = useChatStreamHandler({
        messagesList,
        loading: ref(false),
        isReplying: ref(true),
        currentAssistantMessageId,
        fullContent: ref(''),
        isAgentStreamSession: () => true,
        scrollToBottom: () => {},
      })
      return () => null
    },
  })
  app.use(i18n)
  app.mount({})
  return { handler, messagesList, currentAssistantMessageId }
}

/** Open an agent turn the way the backend does: one agent_query, then answers. */
function startAgentTurn(
  handler: ReturnType<typeof useChatStreamHandler>,
  messagesList: Record<string, unknown>[],
) {
  handler.processStreamChunk({
    response_type: 'agent_query',
    id: 'req1',
    assistant_message_id: 'm1',
    data: { session_id: 's1', query: 'q' },
  })
  const assistant = messagesList[messagesList.length - 1]
  assert.equal(assistant?.role, 'assistant')
  return assistant
}

// SSE 载荷形状：response_type 顶层，event_id 在 data.data 里，content 顶层
const answerChunk = (eventId: string, content: string) => ({
  response_type: 'answer',
  id: 'req1',
  data: { event_id: eventId },
  content,
})

test('new agent answer event must not inherit live prior-round content', () => {
  const { handler, messagesList } = setup()
  const assistant = startAgentTurn(handler, messagesList)

  handler.processStreamChunk(answerChunk('r1', '一、要点一\n二、要点二\n'))
  handler.processStreamChunk(answerChunk('r2', '三、要点三\n'))

  // 修复前：r2 继承 r1 全文再追加 → recompose = '一二' + '一二三'（重复堆叠）
  assert.equal(assistant.content, '一、要点一\n二、要点二\n三、要点三\n')
})

test('tool_call still retracts prior answer rounds', () => {
  const { handler, messagesList } = setup()
  const assistant = startAgentTurn(handler, messagesList)

  handler.processStreamChunk(answerChunk('r1', 'preamble...'))
  handler.processStreamChunk({
    response_type: 'tool_call',
    id: 'req1',
    data: { tool_call_id: 't1', tool_name: 'knowledge_search' },
  })
  handler.processStreamChunk(answerChunk('r2', 'final answer'))

  // 旧文本彻底消失，不因种子残留
  assert.equal(assistant.content, 'final answer')
})

test('catch-up seeding before the first answer event is preserved', () => {
  const { handler, messagesList } = setup()
  const assistant = startAgentTurn(handler, messagesList)

  // 模拟其他路径在首个 answer 事件前已写入 message.content（种子的原始意图）
  assistant.content = '已渲染的前置文本'
  handler.processStreamChunk(answerChunk('r1', '正文'))

  assert.ok(String(assistant.content).startsWith('已渲染的前置文本'))
})
