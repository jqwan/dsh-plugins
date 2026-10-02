/**
 * react-dom 没有随包安装类型（宿主经 ModuleLoader 外部提供），只声明我们
 * 用到的 portal 入口。非模块文件：全局环境声明。
 */
declare module 'react-dom' {
  import type { ReactElement, ReactNode } from 'react'
  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: unknown,
  ): ReactElement
}
