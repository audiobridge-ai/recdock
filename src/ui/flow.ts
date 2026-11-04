export type FlowScreen = 'restore' | 'login' | 'devices' | 'connecting' | 'workspace';
export type WorkspaceTab = 'overview' | 'recordings' | 'settings';
export type ConnectionStep = 'choosing' | 'preparing' | 'gatt' | 'authenticating' | 'reading';

export interface FlowState {
  screen: FlowScreen;
  accountId?: string;
  deviceSerialNumbers: readonly string[];
  selectedSerialNumber?: string;
  workspaceSerialNumber?: string;
  connection: 'offline' | 'connecting' | 'ready';
  step: ConnectionStep;
  tab: WorkspaceTab;
  operation: number;
  error?: string;
}

export type FlowEvent =
  | { type: 'session'; accountId?: string; deviceSerialNumbers?: readonly string[] }
  | { type: 'restore-error'; message: string }
  | { type: 'select-device'; serialNumber: string }
  | { type: 'open-devices' }
  | { type: 'open-workspace' }
  | { type: 'connect-start'; serialNumber: string; step?: ConnectionStep }
  | { type: 'connect-progress'; operation: number; step: ConnectionStep }
  | { type: 'connect-ready'; operation: number; serialNumber: string }
  | { type: 'connect-error'; operation: number; message: string }
  | { type: 'disconnect'; message?: string }
  | { type: 'cancel-connect' }
  | { type: 'tab'; tab: WorkspaceTab }
  | { type: 'logout' };

export const CONNECTION_STEPS: readonly { step: ConnectionStep; label: string }[] = [
  { step: 'choosing', label: '选择蓝牙设备' },
  { step: 'preparing', label: '准备设备认证' },
  { step: 'gatt', label: '建立蓝牙连接' },
  { step: 'authenticating', label: '验证设备身份' },
  { step: 'reading', label: '读取设备状态' },
];

export function initialFlowState(): FlowState {
  return { screen: 'restore', deviceSerialNumbers: [], connection: 'offline', step: 'choosing', tab: 'overview', operation: 0 };
}

function loginState(operation: number, error?: string): FlowState {
  return { ...initialFlowState(), screen: 'login', operation, error };
}
function disconnected(state: FlowState, message?: string): FlowState {
  return { ...state, screen: state.workspaceSerialNumber && state.workspaceSerialNumber === state.selectedSerialNumber ? 'workspace' : state.accountId ? 'devices' : 'login',
    connection: 'offline', operation: state.operation + 1, error: message };
}

/** View state only: credentials, Bluetooth objects and files never enter this reducer. */
export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'session': {
      if (!event.accountId) return loginState(state.operation + 1);
      const deviceSerialNumbers = [...new Set(event.deviceSerialNumbers?.filter(Boolean) ?? [])];
      const sameAccount = state.accountId === event.accountId;
      const workspaceSerialNumber = sameAccount && state.workspaceSerialNumber && deviceSerialNumbers.includes(state.workspaceSerialNumber) ? state.workspaceSerialNumber : undefined;
      const selectedSerialNumber = sameAccount && state.selectedSerialNumber && deviceSerialNumbers.includes(state.selectedSerialNumber)
        ? state.selectedSerialNumber : deviceSerialNumbers.length === 1 ? deviceSerialNumbers[0] : undefined;
      return { ...initialFlowState(), screen: workspaceSerialNumber ? 'workspace' : 'devices', accountId: event.accountId,
        deviceSerialNumbers, selectedSerialNumber, workspaceSerialNumber,
        connection: workspaceSerialNumber && state.connection === 'ready' ? 'ready' : 'offline',
        tab: workspaceSerialNumber ? state.tab : 'overview', operation: state.operation + 1 };
    }
    case 'restore-error': return loginState(state.operation + 1, event.message);
    case 'logout': return loginState(state.operation + 1);
    case 'select-device':
      if (state.connection === 'connecting' || !state.deviceSerialNumbers.includes(event.serialNumber)) return state;
      return { ...state, selectedSerialNumber: event.serialNumber, error: undefined };
    case 'open-devices':
      return state.accountId && state.connection !== 'connecting' ? { ...state, screen: 'devices', error: undefined } : state;
    case 'open-workspace':
      return state.workspaceSerialNumber && state.connection !== 'connecting'
        ? { ...state, screen: 'workspace', selectedSerialNumber: state.workspaceSerialNumber, error: undefined } : state;
    case 'connect-start': {
      if (!state.accountId || state.connection !== 'offline' || !state.deviceSerialNumbers.includes(event.serialNumber)) return state;
      return { ...state, screen: state.workspaceSerialNumber === event.serialNumber ? 'workspace' : 'connecting',
        selectedSerialNumber: event.serialNumber, connection: 'connecting', step: event.step ?? 'choosing', operation: state.operation + 1, error: undefined };
    }
    case 'connect-progress': {
      if (event.operation !== state.operation || state.connection !== 'connecting') return state;
      const next = CONNECTION_STEPS.findIndex(row => row.step === event.step), current = CONNECTION_STEPS.findIndex(row => row.step === state.step);
      return next >= current ? { ...state, step: event.step } : state;
    }
    case 'connect-ready':
      if (event.operation !== state.operation || state.connection !== 'connecting' || event.serialNumber !== state.selectedSerialNumber) return state;
      return { ...state, screen: 'workspace', workspaceSerialNumber: event.serialNumber, connection: 'ready', step: 'reading', error: undefined };
    case 'connect-error':
      if (event.operation !== state.operation || state.connection !== 'connecting') return state;
      return { ...state, screen: state.workspaceSerialNumber === state.selectedSerialNumber ? 'workspace' : 'devices', connection: 'offline', error: event.message };
    case 'disconnect': return disconnected(state, event.message);
    case 'cancel-connect': return state.connection === 'connecting' ? disconnected(state) : state;
    case 'tab': return { ...state, tab: event.tab };
  }
}

export function connectionProgress(state: FlowState) {
  const current = CONNECTION_STEPS.findIndex(row => row.step === state.step);
  return CONNECTION_STEPS.map((row, index) => ({ ...row,
    status: state.connection === 'ready' || index < current ? 'done' as const : state.connection === 'connecting' && index === current ? 'active' as const : 'pending' as const,
  }));
}

export interface BrowserDeviceBinding {
  accountId: string;
  serialNumber: string;
  browserDeviceId: string;
  verifiedPortVersion?: number;
  verifiedAt?: number;
}

/** Pick only non-secret fields from IndexedDB; malformed or another account's cache is never reused. */
export function parseBrowserDeviceBinding(value: unknown, accountId: string, serialNumber: string): BrowserDeviceBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (data.accountId !== accountId || data.serialNumber !== serialNumber || !accountId || !serialNumber ||
    typeof data.browserDeviceId !== 'string' || !data.browserDeviceId || data.browserDeviceId.length > 1024) return;
  if (data.verifiedPortVersion !== undefined && (typeof data.verifiedPortVersion !== 'number' || !Number.isInteger(data.verifiedPortVersion) || data.verifiedPortVersion < 1 || data.verifiedPortVersion > 65535)) return;
  if (data.verifiedAt !== undefined && (typeof data.verifiedAt !== 'number' || !Number.isFinite(data.verifiedAt) || data.verifiedAt < 0)) return;
  return { accountId, serialNumber, browserDeviceId: data.browserDeviceId,
    ...(data.verifiedPortVersion === undefined ? {} : { verifiedPortVersion: data.verifiedPortVersion as number }),
    ...(data.verifiedAt === undefined ? {} : { verifiedAt: data.verifiedAt as number }) };
}

/** getDevices must be prefetched before the click; otherwise requestDevice is invoked immediately in that click. */
export function connectionChoice(accountId: string, serialNumber: string, binding: BrowserDeviceBinding | undefined,
  authorizedDevices: readonly { id: string }[]): { kind: 'reuse'; browserDeviceId: string } | { kind: 'choose' } {
  if (accountId && serialNumber && binding?.accountId === accountId && binding.serialNumber === serialNumber && binding.browserDeviceId && authorizedDevices.some(device => device.id === binding.browserDeviceId)) {
    return { kind: 'reuse', browserDeviceId: binding.browserDeviceId };
  }
  return { kind: 'choose' };
}

export function savedAudioFormat(value: unknown): 'wav' | 'ogg' { return value === 'wav' ? 'wav' : 'ogg'; }

export function cloudFailureAction(code: string, status: number, authenticatedBle: boolean): 'keep-device' | 'retry' | 'login' | 'report' {
  const authorization = status === 401 || code === 'LOGIN_EXPIRED' || code === 'SESSION_EXPIRED';
  if (authenticatedBle && (authorization || code === 'CSRF_REJECTED')) return 'keep-device';
  if (code === 'CSRF_REJECTED') return 'retry';
  return authorization ? 'login' : 'report';
}
