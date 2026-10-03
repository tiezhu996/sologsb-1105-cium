/**
 * 页签间消息通道：某页签提交后广播，其它页签据此回到上一提交点重载主档，
 * 并看到自己暂存步骤与新主档之间可能产生的待核。
 */
export interface CommitBusMessage {
  sheetId: string
  commitSeq: number
  /** 发送页签自身不重复处理 */
  fromTabId: string
}

const CHANNEL_NAME = 'gboldmap-commit-bus'

class CommitBus {
  private channel: BroadcastChannel | null = null
  private listeners = new Set<(message: CommitBusMessage) => void>()

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event: MessageEvent<CommitBusMessage>) => {
        this.listeners.forEach((listener) => listener(event.data))
      }
    }
  }

  post(message: CommitBusMessage): void {
    // 同页签内也派发一份，供本页签界面统一走重载逻辑
    this.listeners.forEach((listener) => listener(message))
    this.channel?.postMessage(message)
  }

  subscribe(listener: (message: CommitBusMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const commitBus = new CommitBus()
