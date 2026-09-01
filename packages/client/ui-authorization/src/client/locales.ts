/** Dictionary namespace owned by this plugin. */

export const NS = 'authorization'

/** Simplified Chinese copy for the authorization surface. */
export const zh = {
  signIn: '登录',
  signInTitle: '登录',
  configureApiKey: '配置 API Key',
  signOut: '退出登录',
  connected: '已连接',
  signInDescription: '在浏览器中完成登录，凭据将安全地保存在本地。',
  apiKeyDescription: '输入 API Key，凭据将安全地保存在本地。',
  openPage: '打开页面',
  promptPlaceholder: '在此输入',
  promptSubmit: '提交',
  cancel: '取消',
  close: '关闭',
  inProgress: '正在等待登录完成…',
  authorized: '已登录',
  cancelled: '已取消',
  failed: '登录失败',
  retry: '重试',
}

/** English copy for the authorization surface. */
export const en = {
  signIn: 'Sign in',
  signInTitle: 'Sign in',
  configureApiKey: 'Configure API key',
  signOut: 'Sign out',
  connected: 'Connected',
  signInDescription: 'Complete the sign-in in your browser; the credential is stored securely on this machine.',
  apiKeyDescription: 'Enter an API key; the credential is stored securely on this machine.',
  openPage: 'Open page',
  promptPlaceholder: 'Type here',
  promptSubmit: 'Submit',
  cancel: 'Cancel',
  close: 'Close',
  inProgress: 'Waiting for the sign-in to complete…',
  authorized: 'Signed in',
  cancelled: 'Cancelled',
  failed: 'Sign-in failed',
  retry: 'Retry',
}

/** The dictionary key union, for the LocaleNamespaceMap augmentation. */
export type AuthorizationKey = keyof typeof zh
