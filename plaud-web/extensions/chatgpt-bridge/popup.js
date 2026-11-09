const status = document.querySelector('#status'), button = document.querySelector('#bind');
async function request(action) { const response = await chrome.runtime.sendMessage({ action }); if (response.error) throw Error(response.error); status.textContent = response.result.bound ? '已连接。可回到录音工作台发送全文。' : '请先打开并登录 ChatGPT，然后连接该页面。'; }
button.onclick = async () => { button.disabled = true; try { await request('bind'); } catch (e) { status.textContent = e.message; } finally { button.disabled = false; } };
request('info').catch(e => { status.textContent = e.message; });
