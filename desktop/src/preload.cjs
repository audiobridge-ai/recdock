'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => value => ipcRenderer.invoke('recdock:' + name, value);
const observe = name => callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('recdock:' + name, listener); return () => ipcRenderer.removeListener('recdock:' + name, listener); };
contextBridge.exposeInMainWorld('recdockDesktop', Object.freeze({
  getLocale: call('get-locale'), setLocale: call('set-locale'), info: call('info'), chooseModels: call('choose-models'), setup: call('setup'), cancelSetup: call('cancel-setup'), saveToken: call('save-token'), removeToken: call('remove-token'), reveal: call('reveal'), copyExtensionPath: call('copy-extension-path'), external: call('external'), login: call('login'), chatgpt: call('chatgpt'), selectBluetooth: call('bluetooth-select'), onSetup: observe('setup-state'), onBluetoothDevices: observe('bluetooth-devices'),
}));
