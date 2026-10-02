/** Pi supplies the native trajectory grouped-record interface. */
import type { TrajectoryCellProps } from './trajectory-record.ts'
export interface TrajectoryGroupModel { title: string; description?: string; cells: readonly TrajectoryCellProps[] }
export interface TrajectoryTurnModel { turn: number | null; groups: readonly TrajectoryGroupModel[] }
