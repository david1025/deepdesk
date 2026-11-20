import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChatStore } from '../../services/chat/store.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import styles from './Usage.module.css'
const fmt = (n: number) => n.toLocaleString('en-US')
// 与 AccountUsage 一致：延迟关闭 + 浮窗取消，鼠标从按钮移向浮窗（穿过空隙）不会闪关
const Metric = ({ id, label, active, setActive, children }: { id: string; label: string; active: boolean; setActive: (id: string | null) => void; children: ReactNode }) => {
  const closeTimer = useRef<number | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setActive(null), 180)
  }
  useEffect(() => () => cancelClose(), [])
  return (
    <div className={styles.metric} onMouseEnter={() => { cancelClose(); setActive(id) }} onMouseLeave={scheduleClose}>
      <button type="button" className={styles.metricButton} aria-expanded={active}
        onFocus={() => setActive(id)} onBlur={() => setActive(null)} onClick={() => setActive(active ? null : id)}>{label}</button>
      {active ? <div className={styles.metricPopover} role="tooltip" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>{children}</div> : null}
    </div>
  )
}
const Detail = ({ label, value }: { label: string; value: string }) => <div className={styles.metricDetail}><span>{label}</span><strong>{value}</strong></div>
export const SessionUsage = ({ sessionId }: { sessionId: string | null }) => {
  const session = useChatStore((state) => sessionId ? state.sessionCache[sessionId] : undefined)
  const [active, setActive] = useState<string | null>(null)
  const usage = useMemo(() => {
    const replies = (session?.messages ?? []).filter((m): m is AssistantMessage & { usage: NonNullable<AssistantMessage['usage']> } => m.role === 'assistant' && !!m.usage)
    return { replies: replies.length, ...replies.reduce((a,m) => ({
      input:a.input+m.usage.input_tokens, create:a.create+m.usage.cache_creation_input_tokens,
      cache:a.cache+m.usage.cache_read_input_tokens, output:a.output+m.usage.output_tokens
    }), {input:0,create:0,cache:0,output:0}) }
  }, [session])
  if (!sessionId) return null
  const input = usage.input + usage.create + usage.cache
  const total = input + usage.output
  const hit = input ? Math.round(usage.cache / input * 100) : 0
  return <div className={styles.sessionUsage}>
    <Metric id="total" label={'本会话　' + fmt(total) + ' tok'} active={active === 'total'} setActive={setActive}>
      <strong className={styles.metricTitle}>本会话 Token 用量</strong>
      <Detail label="未缓存输入" value={fmt(usage.input)+' tok'} /><Detail label="缓存写入" value={fmt(usage.create)+' tok'} />
      <Detail label="缓存读取" value={fmt(usage.cache)+' tok'} /><Detail label="输出" value={fmt(usage.output)+' tok'} />
      <Detail label="完成回复" value={String(usage.replies)} />
    </Metric>
    <Metric id="cache" label={'缓存命中　' + hit + '%'} active={active === 'cache'} setActive={setActive}>
      <strong className={styles.metricTitle}>上下文缓存</strong>
      <Detail label="缓存命中率" value={hit+'%'} /><Detail label="缓存读取" value={fmt(usage.cache)+' tok'} />
      <Detail label="缓存写入" value={fmt(usage.create)+' tok'} /><Detail label="未缓存输入" value={fmt(usage.input)+' tok'} />
    </Metric>
    <Metric id="output" label={'输出　' + fmt(usage.output)} active={active === 'output'} setActive={setActive}>
      <strong className={styles.metricTitle}>输出 Token</strong><Detail label="累计输出" value={fmt(usage.output)+' tok'} />
      <Detail label="完成回复" value={String(usage.replies)} />
    </Metric>
  </div>
}
