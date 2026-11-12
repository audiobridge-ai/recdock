export interface SetupState { running: boolean; kind?: string; message?: string; ok?: boolean; report?: unknown }
export interface DesktopInfo { version: string; platform: string; modelsDirectory: string; modelsPrepared: boolean; freeBytes: number; setup: SetupState; extensionConnected: boolean; extensionDirectory: string; loginAtStart: boolean; tokenSaved: boolean; distribution: string }
export interface DesktopAPI {
  getLocale(): Promise<'en' | 'zh-CN'>;
  setLocale(locale: 'en' | 'zh-CN'): Promise<'en' | 'zh-CN'>;
  info(): Promise<DesktopInfo>;
  chooseModels(): Promise<DesktopInfo>;
  setup(mode: 'download' | 'verify' | 'probe'): Promise<SetupState>;
  cancelSetup(): Promise<void>;
  saveToken(token: string): Promise<unknown>;
  removeToken(): Promise<unknown>;
  reveal(kind: 'extension' | 'models' | 'data'): Promise<unknown>;
  copyExtensionPath(): Promise<unknown>;
  external(url: string): Promise<unknown>;
  login(enabled: boolean): Promise<boolean>;
  chatgpt(value: { action: string; payload?: unknown }): Promise<unknown>;
  selectBluetooth(id: string): Promise<unknown>;
  onSetup(callback: (state: SetupState) => void): () => void;
  onBluetoothDevices(callback: (devices: { id: string; name: string }[]) => void): () => void;
}
declare global { interface Window { recdockDesktop?: DesktopAPI } }
