const status = document.querySelector('#status'), button = document.querySelector('#bind'), toggle = document.querySelector('#language');
const messages = await fetch(chrome.runtime.getURL('ui-en.json')).then(response => response.json());
let locale = 'en', lastMessage = '', bound;
try { locale = (await chrome.storage.local.get('recdock.uiLanguage'))['recdock.uiLanguage'] === 'zh-CN' ? 'zh-CN' : 'en'; } catch {}
const t = text => locale === 'en' ? messages[text] || text : text;
function render() {
  document.documentElement.lang = locale; toggle.textContent = locale === 'en' ? '中文' : 'English'; toggle.lang = locale === 'en' ? 'zh-CN' : 'en'; toggle.setAttribute('aria-label', locale === 'en' ? 'Switch language to Chinese' : '切换为英文');
  button.textContent = t('连接现有 ChatGPT 页面');
  document.querySelector('#hint').textContent = locale === 'en' ? 'Reuses one tab and sends tasks in order. Reconnect after changing ChatGPT accounts.' : '固定复用一个标签页，按顺序发送。更换 ChatGPT 账号后请重新连接。';
  status.textContent = lastMessage ? t(lastMessage) : bound === undefined ? locale === 'en' ? 'Checking connection…' : '正在检查连接…' : t(bound ? '已连接。可回到录音工作台发送全文。' : '请先打开并登录 ChatGPT，然后连接该页面。');
}
async function request(action) { const response = await chrome.runtime.sendMessage({ action }); if (response.error) throw Error(response.error); bound = response.result.bound; lastMessage = ''; render(); }
button.onclick = async () => { button.disabled = true; try { await request('bind'); } catch (e) { lastMessage = e.message; render(); } finally { button.disabled = false; } };
toggle.onclick = async () => { locale = locale === 'en' ? 'zh-CN' : 'en'; try { await chrome.storage.local.set({ 'recdock.uiLanguage': locale }); } catch {} render(); };
render(); request('info').catch(e => { lastMessage = e.message; render(); });
