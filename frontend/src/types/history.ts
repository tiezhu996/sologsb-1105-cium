export type NameChangeType = '初置' | '改名' | '迁治' | '废置'

export interface NameHistory {
  id: string
  placePairId: string
  period: string
  name: string
  changeType: NameChangeType
  sourceRef: string
  note: string
  /** 主档行版本，随成功重放自增，作为提交时的乐观锁。 */
  rowRev?: number
}

export const NAME_CHANGE_TYPES: NameChangeType[] = ['初置', '改名', '迁治', '废置']
