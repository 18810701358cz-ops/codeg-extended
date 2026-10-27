"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  useConnectionStore,
  type LiveMessage,
} from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { useTokenOutputSpeed } from "@/hooks/use-token-output-speed"
import {
  IDLE_TOKEN_METER_SETTLED,
  LiveTokenCounter,
  hasTokenMeterListeners,
  resolveTotalTokens,
  setTokenMeterLiveSample,
  setTokenMeterSettled,
  watchTokenMeterListeners,
} from "@/lib/plugin-host/token-meter"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/** Same period as `useTokenOutputSpeed`, so the count and the speed move together. */
const SAMPLE_MS = 500

/**
 * Publishes one turn's live reading: the speed from `useTokenOutputSpeed`
 * (so it matches the chat's streaming row exactly) and a running token
 * estimate from the same text. Mounted for the life of one turn, as that hook
 * expects, and only while a plugin listens.
 */
function LiveTurnMeter({ message }: { message: LiveMessage }) {
  const tokensPerSecond = useTokenOutputSpeed(message)

  // The timer below reads the message through a ref. Written in an effect,
  // never during render, as in `useTokenOutputSpeed`.
  const messageRef = useRef(message)
  useEffect(() => {
    messageRef.current = message
  })

  const [liveTokens, setLiveTokens] = useState(0)
  useEffect(() => {
    const counter = new LiveTokenCounter()
    const timer = setInterval(() => {
      setLiveTokens(Math.round(counter.measure(messageRef.current)))
    }, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [])

  const messageId = message.id
  useEffect(() => {
    setTokenMeterLiveSample({ messageId, liveTokens, tokensPerSecond })
  }, [messageId, liveTokens, tokensPerSecond])
  useEffect(() => () => setTokenMeterLiveSample(null), [])

  return null
}

/**
 * Selects the live message itself, so only this subtree re-renders on every
 * streamed delta. The bridge above it reads primitives and stays quiet.
 */
function LiveTurnSampler({ conversationId }: { conversationId: number }) {
  const message = useConversationRuntimeStore(
    (s) => s.byConversationId.get(conversationId)?.liveMessage ?? null
  )
  return message ? <LiveTurnMeter message={message} /> : null
}

/**
 * Keeps `ctx.tokens` current: the reported total of the focused conversation
 * and whether it is streaming, always; the live speed and token estimate only
 * while a plugin listens, so a user without such a plugin pays almost nothing.
 *
 * Mounted beside `<PluginHost />` in the workspace layout, which puts it inside
 * every provider it reads. Renders nothing.
 */
export function TokenMeterBridge() {
  const store = useConnectionStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  // The focused tab's runtime conversation: the same resolution
  // `ComposerContextUsage` uses (a new conversation's virtual id comes first).
  const conversationId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === s.activeTabId)
    if (!tab || tab.kind !== "conversation") return null
    return tab.runtimeConversationId ?? tab.conversationId ?? null
  })
  const totalTokens = useConversationRuntimeStore((s) =>
    conversationId == null
      ? null
      : resolveTotalTokens(s.byConversationId.get(conversationId)?.sessionStats)
  )
  const liveMessageId = useConversationRuntimeStore((s) =>
    conversationId == null
      ? null
      : (s.byConversationId.get(conversationId)?.liveMessage?.id ?? null)
  )

  const subscribeConnection = useCallback(
    (cb: () => void) =>
      activeTabId ? store.subscribeKey(activeTabId, cb) : () => {},
    [store, activeTabId]
  )
  const getConnectionStatus = useCallback(
    () => (activeTabId ? store.getConnection(activeTabId)?.status : undefined),
    [store, activeTabId]
  )
  const connectionStatus = useSyncExternalStore(
    subscribeConnection,
    getConnectionStatus,
    getConnectionStatus
  )

  // The chat's own gate for its streaming row: a live message can stay attached
  // for a moment after the prompt ends.
  const streaming = liveMessageId !== null && connectionStatus === "prompting"
  const listening = useSyncExternalStore(
    watchTokenMeterListeners,
    hasTokenMeterListeners,
    () => false
  )

  useEffect(() => {
    setTokenMeterSettled({ totalTokens, streaming, liveMessageId })
  }, [totalTokens, streaming, liveMessageId])
  useEffect(() => () => setTokenMeterSettled(IDLE_TOKEN_METER_SETTLED), [])

  if (!listening || !streaming || conversationId == null) return null
  return <LiveTurnSampler key={liveMessageId} conversationId={conversationId} />
}
