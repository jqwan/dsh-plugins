/** Supplemental pi entries anchored to the preceding visible message in the active branch. */
export interface PiTrajectoryEntry {
  id: string
  type: string
  timestamp?: string
  afterEntryId?: string | null
  [key: string]: unknown
}
