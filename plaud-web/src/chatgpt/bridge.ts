import { DEFAULT_CHATGPT_PROMPT } from './types.ts';
import type { BridgeInfo, BridgeTask, ForwardPacket } from './types.ts';

const CHANNEL = 'recdock-chatgpt-v1';
export class ChatGPTBridgeTimeout extends Error { constructor(action: string) { super(action === 'info' ? 'ChatGPT 扩展暂未响应。若已安装，请刷新工作台后检查连接。' : '等待 ChatGPT 扩展回执超时，请检查已连接页面并核对发送状态；当前不能据此判断是否已经提交。'); } }
export class ChatGPTBridge {
  private request<T>(action: string, payload?: unknown, timeout = 4000): Promise<T> {
    return new Promise((resolve, reject) => {
      const targetWindow = window, origin = targetWindow.location.origin;
      const requestId = crypto.randomUUID();
      const finish = () => { clearTimeout(timer); targetWindow.removeEventListener('message', receive); };
      const receive = (event: MessageEvent) => {
        if (event.source !== targetWindow || event.origin !== origin || event.data?.channel !== CHANNEL || event.data?.type !== 'response' || event.data?.requestId !== requestId) return;
        finish();
        if (event.data.error) reject(new Error(String(event.data.error).slice(0, 600))); else resolve(event.data.result as T);
      };
      const timer = setTimeout(() => { finish(); reject(new ChatGPTBridgeTimeout(action)); }, timeout);
      targetWindow.addEventListener('message', receive);
      targetWindow.postMessage({ channel: CHANNEL, type: 'request', requestId, action, payload }, origin);
    });
  }
  async info() { const result = await this.request<BridgeInfo>('info', undefined, 4000); if (result.version !== 1 || !/^[a-f0-9-]{16,100}$/.test(result.targetId)) throw new Error('ChatGPT 扩展版本不兼容，请重新加载扩展。'); return result; }
  bind() { return this.request<BridgeInfo>('bind'); }
  start(packet: ForwardPacket) { return this.request<BridgeTask>('start', packet, 12000); }
  status(id: string) { return this.request<BridgeTask | null>('status', { id }); }
  open(conversationUrl: string) { return this.request('open', { conversationUrl }); }
}
export function chatgptPrompt() { try { return window.localStorage.getItem('recdock.chatgptPrompt') || DEFAULT_CHATGPT_PROMPT; } catch { return DEFAULT_CHATGPT_PROMPT; } }
export function saveChatgptPrompt(value: string) { const text = value.trim(); if (!text || text.length > 6000) throw new Error('提示词需要 1–6000 个字符。'); try { window.localStorage.setItem('recdock.chatgptPrompt', text); } catch { throw new Error('浏览器未允许保存设置，请检查本机存储。'); } }
