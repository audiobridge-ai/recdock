export const DEFAULT_CHATGPT_PROMPT = '请阅读这份录音转写，整理主要内容、关键结论和待办事项。回答时引用讲话人与时间；未确定的信息请明确说明。';
export type ForwardState = 'prepared' | 'attaching' | 'attached' | 'submitting' | 'submitted' | 'user_action_required' | 'failed';
export interface ForwardTransfer {
  id: string; recordingId: string; revisionId: string; targetId: string; sha256: string; promptHash: string; filename: string;
  state: ForwardState; createdAtMs: number; updatedAtMs: number; conversationUrl?: string; message?: string; submissionAttempted?: boolean;
}
export interface ForwardPacket { transfer: ForwardTransfer; content: string; prompt: string }
export interface BridgeInfo { version: number; targetId: string; bound: boolean; targetLabel: string; activeTaskId?: string }
export interface BridgeTask { id: string; state: ForwardState; conversationUrl?: string; message?: string }
