import { zh as nativeLabels } from './dsh-chat/chat-locales.ts'
import { zh as commonLabels } from './dsh-trajectory/common-locales.ts'
/** Labels used by the transplanted DSH message action component. */
export type ChatTranslate = (key: string, params?: Record<string, unknown>) => string
const labels: Record<string, string> = {
  ...commonLabels, ...nativeLabels,
  'header.emptyName': '会话名称不能为空',
  'header.editTask': '编辑任务', 'header.rename': '重命名会话', 'header.sessionName': '会话名称', 'header.cancel': '取消', 'header.save': '保存',
  'trajectory.timingSource': 'pi 执行事件（单调时钟）',
  'trajectory.compaction': '上下文压缩', 'trajectory.branch_summary': '分支摘要', 'trajectory.model_change': '模型变更', 'trajectory.thinking_level_change': '思考等级变更',
  'trajectory.title': '轨迹', 'trajectory.search': '搜索轨迹', 'trajectory.expand': '展开全部', 'trajectory.collapse': '折叠全部',
  'trajectory.event': '事件', 'trajectory.content': '内容', 'trajectory.older': '加载更早', 'trajectory.empty': '暂无匹配记录',
  'trajectory.turn': '第 {turn} 回合', 'trajectory.user': '用户消息', 'trajectory.assistant': '模型回复', 'trajectory.thinking': '思考',
  'trajectory.tool': '工具调用', 'trajectory.result': '工具结果', 'trajectory.running': '工具执行中', 'trajectory.image': '图片',
  'trajectory.usage': '用量', 'trajectory.error': '错误', 'trajectory.aborted': '已中断', 'trajectory.notice': '通知',

  'context.details': '上下文占用详情', 'context.used': '上下文已用',
  'hero.selectTask': '选择任务', 'hero.newTask': '新建任务…', 'hero.createFailed': '创建会话失败', 'hero.needTask': '请先选择一个任务，或新建一个任务',
  'hero.headline': '探索未至之境', 'hero.preview': '预览版',
  copy: '复制', copied: '已复制', 'message.branch': '从此处分支',
  'message.branchUnavailable': '当前消息无法分支', 'clock.md': '{m}月{d}日', 'clock.ymd': '{y}年{m}月{d}日',
}
export const chatT: ChatTranslate = (key, params = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
