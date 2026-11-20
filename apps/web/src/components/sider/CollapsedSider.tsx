import clsx from 'clsx'
import { IconPanelLeftOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed, useSettings } from '../../services/settings.js'
import { newChat, useChatStore } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'
import { isMacDesktop } from '../../services/desktop.js'

/**
 * 收起后左上角的按钮组；macOS 隐藏标题栏时与红绿灯同行（右侧），官方样式为裸图标不带胶囊底。
 * mac 收起态还把当前会话标题排进同一行（官方样式：红绿灯 → 折叠按钮 → 新会话 → 标题），
 * 此时 SessionView 头部的标题隐藏以免重复。
 * 常驻挂载 + 淡入淡出：收起时等侧栏宽度动画结束再出现（延迟），展开时立即退场。
 */
export const CollapsedSider = () => {
  const t = useTranslate()
  const mac = isMacDesktop()
  const collapsed = useSettings((state) => state.siderCollapsed)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const title = session ? session.title || t('untitledChat') : null
  return (
    <div
      className={clsx(
        styles.collapsed,
        mac && styles.collapsedMac,
        collapsed ? styles.rowShown : styles.rowHidden
      )}
    >
      {mac ? (
        <>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('expandSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => setSiderCollapsed(false)}
          />
          <IconButton
            size="m"
            tone="primary"
            icon={<NewChatIcon />}
            tooltip={t('newChat')}
            tooltipPlacement="bottom"
            onClick={newChat}
          />
          {title ? <div className={styles.collapsedMacTitle}>{title}</div> : null}
        </>
      ) : (
        <div className={styles.collapsedGroup}>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('expandSiderbarButton')}
            onClick={() => setSiderCollapsed(false)}
          />
          <IconButton size="m" tone="primary" icon={<NewChatIcon />} tooltip={t('newChat')} onClick={newChat} />
        </div>
      )}
    </div>
  )
}
