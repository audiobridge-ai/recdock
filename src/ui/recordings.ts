import type { RecordingStatus } from '../protocol/recording.ts';
import { recordingDuration } from '../protocol/recording.ts';
import type { RecordingFile } from '../protocol/files.ts';

export interface TransferStatus {
  phase: 'idle' | 'downloading' | 'cancelling' | 'complete' | 'cancelled' | 'paused' | 'error';
  sessionId?: number;
  received: number;
  total: number;
  error?: string;
  notice?: string;
  filename?: string;
}

export function formatRecordingDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return '—';
  const seconds = Math.floor(durationMs / 1000), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60;
  return [hours ? String(hours).padStart(2, '0') : undefined, String(minutes).padStart(2, '0'), String(rest).padStart(2, '0')]
    .filter(part => part !== undefined).join(':');
}

export function recordingView(status: RecordingStatus, now: number) {
  const labels: Record<RecordingStatus['mode'], string> = {
    unknown: '录音状态待确认', idle: '空闲', recording: '正在录音', paused: '录音已暂停', transferring: '文件传输中',
  };
  return {
    label: labels[status.mode],
    duration: formatRecordingDuration(recordingDuration(status, now)),
    durationLabel: status.mode === 'recording' || status.mode === 'paused' ? '当前录音时长' : '最近录音时长',
    session: status.sessionId === undefined ? '未获取' : String(status.sessionId),
    scene: status.scene === undefined ? '未获取' : String(status.scene),
  };
}

export function recordingFilesBlocked(status: RecordingStatus): boolean {
  return status.mode === 'recording' || status.mode === 'paused' || status.mode === 'transferring';
}

export function recordingFilesHint(status: RecordingStatus, ready: boolean): string {
  if (!ready) return '设备认证完成后可读取录音目录。文件仅通过蓝牙传到本机，由你主动保存。';
  if (status.mode === 'recording' || status.mode === 'paused') return '设备正在录音或录音已暂停，目录读取与下载暂缓。请先在设备上结束录音，再刷新状态。';
  if (status.mode === 'transferring') return '设备正处于文件传输状态，请等待传输结束后再刷新目录或下载其他文件。';
  if (status.mode === 'unknown') return '录音状态尚未确认。刷新目录或下载时会先检查设备是否空闲。';
  return '会话 ID 是设备文件标识，不代表录音时间。录音文件仅保留在内存和你主动保存的本机文件中。';
}

export function recordingFileView(file: RecordingFile) {
  const metadata: string[] = [];
  if (file.scene !== undefined) metadata.push(`场景 ${file.scene}`);
  if (file.attribute !== undefined) metadata.push(`属性 ${file.attribute}`);
  return { id: String(file.sessionId), metadata: metadata.join(' · ') };
}

export function downloadActionLabel(sessionId: number, transfer: TransferStatus): string {
  if (transfer.sessionId !== sessionId) return '下载';
  if (transfer.phase === 'downloading') return '下载中…';
  if (transfer.phase === 'cancelling') return '停止中…';
  if (['paused', 'cancelled', 'error'].includes(transfer.phase) && transfer.received > 0) return '继续下载';
  if (transfer.phase === 'error') return '重试';
  return '下载';
}

export function transferView(transfer: TransferStatus) {
  const labels: Record<TransferStatus['phase'], string> = {
    idle: '尚无下载', downloading: '正在通过蓝牙下载', cancelling: '正在取消下载',
    complete: '下载完成', cancelled: '下载已取消', paused: '下载已暂停', error: '下载未完成',
  };
  const received = Number.isFinite(transfer.received) ? Math.max(0, transfer.received) : 0;
  const total = Number.isFinite(transfer.total) ? Math.max(0, transfer.total) : 0;
  const percent = total ? Math.min(100, Math.max(0, received * 100 / total)) : 0;
  const recovery = transfer.phase === 'paused'
    ? '已保留本设备的下载进度。设备空闲后可继续；连接中断时，请重新连接同一设备并刷新目录，再点击“继续下载”。'
    : transfer.phase === 'cancelled'
      ? '未保存不完整文件。若保留了接收进度，可点击同一文件继续下载。'
      : transfer.phase === 'error'
        ? '未保存不完整文件。检查设备状态后，可重试同一文件；保留的进度会继续使用。'
        : transfer.phase === 'cancelling' ? '正在结束设备传输，请稍候。' : '';
  const detail = [transfer.error, transfer.notice, recovery].filter(Boolean).join(' ');
  return {
    label: labels[transfer.phase], received, total, percent, detail,
    canCancel: transfer.phase === 'downloading',
    cancelling: transfer.phase === 'cancelling',
  };
}

/** Only a fully completed transfer may be offered to the browser for saving. */
export function canSaveCompletedDownload(transfer: TransferStatus, sessionId: number): boolean {
  return transfer.phase === 'complete' && transfer.sessionId === sessionId &&
    Number.isSafeInteger(transfer.received) && Number.isSafeInteger(transfer.total) &&
    transfer.total >= 0 && transfer.received === transfer.total;
}
