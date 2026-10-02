/**
 * 原生侧栏品牌行接管：brand.mark 渲染 π/dsh 图标、brand.name 渲染名称文字
 * （仅作当前会话列表类型的标识）。点击不再透传原生 New Session（startSession
 * 会继承最近工作区并直接开空会话，产生无任务归属的孤儿会话）——与 pi 英雄
 * 同款：拦截点击，清暂选任务并清掉原生当前会话，英雄首屏回到“未选工作区”
 * 的惰性输入姿态，没选任务就发不了消息；文字右侧仍是界面前进/后退
 * （自带 stopPropagation）。
 */

import type { ReactElement } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createWorkbenchStore } from './store.ts'
import type { NativeSessionsFace } from './host.ts'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { ICONS } from './ui.tsx'
import css from './workbench.module.css'

const stop = (event: { stopPropagation(): void }) => { event.stopPropagation() }

type BrandStoreProps = PropsStore<ReturnType<typeof createWorkbenchStore>> & { nativeSessions: NativeSessionsFace | null }

/** 品牌按钮打开对应的英雄界面；都先拦下原生点击，pi 草稿不创建持久会话。 */
function useBrandHero(useStore: BrandStoreProps['useStore'], actions: BrandStoreProps['actions'], nativeSessions: NativeSessionsFace | null): (event: { stopPropagation(): void }) => void {
  const kind = useStore((state) => state.kind)
  return (event) => {
    event.stopPropagation()
    if (kind !== 'pi') {
      actions.setView('dsh')
      // dsh 英雄与 pi 同款：不选任务不能发消息。清暂选任务 + 清原生当前
      // 会话后，输入卡回到“未选工作区”触发器姿态（点击只会经工作区选择
      // 门弹新建任务），原生不会再继承最近工作区悄悄开出无归属会话。
      actions.setHeroTask(null)
      nativeSessions?.clear?.()
      return
    }
    actions.openPiDraft(null)
  }
}

/** brand.mark：π/dsh 图标（标识当前列表；点击进对应首屏）。 */
export function WorkbenchBrandMark(props: PropsRuntime<'sidebar.brand.mark'> & BrandStoreProps): ReactElement {
  const { useStore, actions, nativeSessions } = props
  const kind = useStore((state) => state.kind)
  const enterHero = useBrandHero(useStore, actions, nativeSessions)
  return (
    <span
      className={css.brandToggle}
      title={`新建 ${kind === 'pi' ? 'pi' : 'dsh'} 会话`}
      onClick={enterHero}
    >
      {kind === 'pi' ? <PiPixelMark /> : <FishLogo size={20} />}
    </span>
  )
}

/** pi 品牌图标；按参考图绘制为可缩放的块面 SVG。 */
export function PiPixelMark({ size = 20 }: { size?: number } = {}): ReactElement {
  return (
    <svg
      viewBox="0 0 242 212"
      width={size}
      height={size}
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={{ display: 'block' }}
      fill="currentColor"
    >
      <rect x="52" y="33" width="35" height="142" />
      <rect x="87" y="33" width="36" height="35" />
      <rect x="123" y="33" width="35" height="71" />
      <rect x="87" y="104" width="36" height="35" />
      <rect x="158" y="104" width="35" height="71" />
    </svg>
  )
}

/** brand.name：名称文字 + 界面前进/后退。文字点击同样进对应首屏；前进/后退自身拦截冒泡。 */
export function WorkbenchBrandName(props: PropsRuntime<'sidebar.brand.name'> & BrandStoreProps): ReactElement {
  const { useStore, actions, nativeSessions } = props
  const kind = useStore((state) => state.kind)
  const enterHero = useBrandHero(useStore, actions, nativeSessions)
  const canBack = useStore((state) => state.histPast.length > 0)
  const canForward = useStore((state) => state.histFuture.length > 0)
  return (
    <span className={css.brandHistory} onClick={enterHero}>
      <span className={css.brandKindText}>{kind === 'pi' ? 'PI AI AGENT' : 'DSH 本地构建'}</span>
      <span className={css.brandNavSpace} />
      <span
        role="button"
        tabIndex={canBack ? 0 : -1}
        className={`${css.brandNav}${canBack ? '' : ` ${css.brandNavOff}`}`}
        title="后退（上一个界面）"
        onClick={(event) => { stop(event); if (canBack) actions.goBack() }}
      >
        <span className={css.brandNavFlip}>{ICONS.chevron}</span>
      </span>
      <span
        role="button"
        tabIndex={canForward ? 0 : -1}
        className={`${css.brandNav}${canForward ? '' : ` ${css.brandNavOff}`}`}
        title="前进（下一个界面）"
        onClick={(event) => { stop(event); if (canForward) actions.goForward() }}
      >
        {ICONS.chevron}
      </span>
    </span>
  )
}
