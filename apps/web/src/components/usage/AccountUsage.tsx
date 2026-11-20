import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { getNativeBalance } from '../../services/native.js'
import { loadAllUsageMessages } from '../../services/chat/db.js'
import styles from './Usage.module.css'

type Balance = Awaited<ReturnType<typeof getNativeBalance>>
type UsageRecord = Omit<Awaited<ReturnType<typeof loadAllUsageMessages>>[number], 'usage'> & { usage: NonNullable<Awaited<ReturnType<typeof loadAllUsageMessages>>[number]['usage']> }

const formatMoney = (value: number, currency: string) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value)
const estimate = (records: UsageRecord[]) => records.reduce((sum, record) => {
  const pro = record.model === 'deepseek-v4-pro'
  const input = record.usage.input_tokens + record.usage.cache_creation_input_tokens
  const cache = record.usage.cache_read_input_tokens
  const output = record.usage.output_tokens
  // Peak-hour CNY list prices. Search/fetch, OCR, ASR and TTS are excluded.
  return sum + (input * (pro ? 9 : 2) + cache * (pro ? .3 : .04) + output * (pro ? 27 : 8)) / 1_000_000
}, 0)

export const AccountUsage = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 延迟关闭：鼠标从按钮移向浮窗（含穿过空隙）时不会因瞬间 mouseleave 而关闭
  const closeTimer = useRef<number | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 180)
  }
  useEffect(() => () => cancelClose(), [])

  const refresh = async () => {
    if (!apiKey || busy) return
    setBusy(true)
    setError('')
    try {
      const [nextBalance, nextRecords] = await Promise.all([getNativeBalance(), loadAllUsageMessages()])
      setBalance(nextBalance)
      setRecords(nextRecords)
      setUpdated(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (apiKey) void refresh()
  }, [apiKey])

  const stats = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const today = records.filter((item) => item.completedAt >= todayStart)
    const month = records.filter((item) => item.completedAt >= monthStart)
    return {
      totalTokens: records.reduce((sum, item) => sum + item.usage.input_tokens + item.usage.cache_creation_input_tokens + item.usage.cache_read_input_tokens + item.usage.output_tokens, 0),
      todayCost: estimate(today),
      monthCost: estimate(month),
      count: records.length,
    }
  }, [records])

  const info = balance?.balance_infos?.[0]
  const currency = info?.currency ?? 'CNY'
  const amount = info ? Number(info.total_balance) : null

  return (
    <div className={styles.accountUsage} onMouseEnter={() => { cancelClose(); setOpen(true); if (!balance && apiKey) void refresh() }} onMouseLeave={scheduleClose}>
      <button type="button" className={styles.balanceButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={styles.walletIcon}>◉</span>
        <span>{amount === null ? (apiKey ? '额度' : '配置 API') : formatMoney(amount, currency)}</span>
      </button>
      {open ? (
        <div className={styles.balancePopover} role="dialog" aria-label="API 账户用量" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
          <div className={styles.popoverHeader}><strong>DeepSeek API 账户</strong><span>{balance?.is_available ? '可用' : balance ? '余额不足' : '未连接'}</span></div>
          {info ? <>
            <div className={styles.balanceAmount}>{formatMoney(Number(info.total_balance), currency)}</div>
            <div className={styles.balanceSplit}><span>充值余额</span><b>{formatMoney(Number(info.topped_up_balance), currency)}</b></div>
            <div className={styles.balanceSplit}><span>赠送余额</span><b>{formatMoney(Number(info.granted_balance), currency)}</b></div>
          </> : <p className={styles.balanceError}>{error || (apiKey ? '正在查询余额…' : '请先配置 API Key')}</p>}
          <div className={styles.popoverDivider} />
          <div className={styles.balanceSplit}><span>今日 Token 费用估算</span><b>{formatMoney(stats.todayCost, 'CNY')}</b></div>
          <div className={styles.balanceSplit}><span>本月 Token 费用估算</span><b>{formatMoney(stats.monthCost, 'CNY')}</b></div>
          <div className={styles.balanceSplit}><span>本机累计 Token</span><b>{stats.totalTokens.toLocaleString()}</b></div>
          <div className={styles.balanceSplit}><span>已统计回复</span><b>{stats.count}</b></div>
          <div className={styles.popoverFoot}>
            <small>{updated ? '更新于 ' + new Date(updated).toLocaleTimeString() : '余额为官方实时查询；费用为本机估算'}</small>
            <button type="button" disabled={busy || !apiKey} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
          </div>
          <small className={styles.estimateNote}>费用按当前公开高峰单价估算；不含联网搜索/抓取、文件解析及语音费用。其他设备的 API 消耗不会计入本机统计。</small>
        </div>
      ) : null}
    </div>
  )
}
