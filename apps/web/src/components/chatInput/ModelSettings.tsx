import { useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { ChatModel, ReasoningEffort } from '../../services/api/types.js'
import { setModel, setProfessionalMode, setReasoningEffort, useSettings } from '../../services/settings.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import styles from './ModelSettings.module.css'

const models: { value: ChatModel; label: string }[] = [
  { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
]
const efforts: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

export const ModelSettings = () => {
  const t = useTranslate()
  const professionalMode = useSettings((state) => state.professionalMode)
  const model = useSettings((state) => state.model)
  const effort = useSettings((state) => state.reasoningEffort)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<'model' | 'effort' | null>(null)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(
    open, { side: 'top', align: 'start', offset: 8 }
  )
  useDismiss(open, [anchorRef, floatingRef], () => {
    setOpen(false)
    setExpanded(null)
  }, { captureEscape: true })

  const modelName = models.find((item) => item.value === model)?.label ?? models[0].label
  const effortName = efforts.find((item) => item.value === effort)?.label ?? 'High'

  const openProfessionalSettings = () => {
    if (!professionalMode) {
      setProfessionalMode(true)
    }
    setExpanded(null)
    setOpen(true)
  }
  const closeProfessionalSettings = () => {
    setProfessionalMode(false)
    setExpanded(null)
    setOpen(false)
  }

  return <>
    <button
      ref={anchorRef}
      type="button"
      className={clsx(styles.trigger, professionalMode && styles.active)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-pressed={professionalMode}
      aria-label={professionalMode ? modelName + ' ' + effortName : t('professionalSettingsTitle')}
      title={professionalMode ? modelName + ' · ' + effortName : t('professionalSettingsTitle')}
      onClick={() => {
        if (!professionalMode) {
          openProfessionalSettings()
        } else {
          setOpen((value) => !value)
          setExpanded(null)
        }
      }}
    >
      {professionalMode ? <>
        <span className={styles.modelName}>{modelName}</span>
        <span className={styles.effortName}>{effortName}</span>
      </> : <span>专业</span>}
      <IconChevronDownOutline14 />
    </button>
    {open ? createPortal(
      <div
        ref={floatingRef}
        className={styles.panel}
        style={position ?? undefined}
        role="dialog"
        aria-label={t('professionalSettingsTitle')}
      >
        <div className={styles.row}>
          <span className={styles.label}>{t('settingsModelLabel')}</span>
          <button
            type="button"
            className={styles.rowTrigger}
            aria-expanded={expanded === 'model'}
            onClick={() => setExpanded((value) => value === 'model' ? null : 'model')}
          >
            <span>{modelName}</span>
            <IconChevronDownOutline14 />
          </button>
          {expanded === 'model' ? (
            <div className={clsx(styles.options, styles.modelOptions)} role="listbox" aria-label={t('settingsModelLabel')}>
              {models.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={item.value === model}
                  className={styles.option}
                  onClick={() => { setModel(item.value); setExpanded(null) }}
                >
                  <span>{item.label}</span>
                  {item.value === model ? <IconCheckOutline16 /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('settingsReasoningEffortLabel')}</span>
          <button
            type="button"
            className={styles.rowTrigger}
            aria-expanded={expanded === 'effort'}
            onClick={() => setExpanded((value) => value === 'effort' ? null : 'effort')}
          >
            <span>{effortName}</span>
            <IconChevronDownOutline14 />
          </button>
          {expanded === 'effort' ? (
            <div className={clsx(styles.options, styles.effortOptions)} role="listbox" aria-label={t('settingsReasoningEffortLabel')}>
              {efforts.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={item.value === effort}
                  className={styles.option}
                  onClick={() => { setReasoningEffort(item.value); setExpanded(null) }}
                >
                  <span>{item.label}</span>
                  {item.value === effort ? <IconCheckOutline16 /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className={styles.footer}>
          <span>{t('professionalSettingsTitle')}</span>
          <button type="button" onClick={closeProfessionalSettings}>{t('professionalModeExit')}</button>
        </div>
      </div>,
      document.body
    ) : null}
  </>
}
