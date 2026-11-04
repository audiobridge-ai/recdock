/** Presentation only; actions and state remain in LibraryWorkspace. */
export const recordingIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 10v4m4-8v12m4-15v18m4-14v10m4-7v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

export const workspaceMarkup = `
  <header class="library-appbar">
    <div class="library-brand"><strong>录音工作台</strong><span>本地音频与转写</span></div>
    <div class="library-device-bar">
      <div class="library-device-anchor">
        <button class="library-device-identity" data-action="device-settings" aria-haspopup="true" aria-expanded="false"><span class="library-device-dot" aria-hidden="true"></span><span class="library-device-copy"><strong data-view="device-name">PLAUD 未连接</strong><span data-view="device-status">本机录音随时可用</span></span><span aria-hidden="true">⌄</span></button>
        <div class="library-popover" data-view="device-menu" hidden><p class="library-menu-label">PLAUD 设备</p><p data-view="device-menu-status"></p><button data-action="device-details">查看设备详情</button><button data-action="menu-refresh">刷新录音目录</button><button data-action="switch-device">切换设备</button><button data-action="disconnect-device">断开连接</button></div>
      </div>
      <div class="library-device-controls"><span data-view="device-duration"></span><span data-view="device-battery"></span><button data-action="connect-device">连接设备</button><div class="library-account-anchor"><button data-action="account-menu" aria-haspopup="true" aria-expanded="false">账号</button><div class="library-popover library-account-menu" data-view="account-menu" hidden><p class="library-menu-label">PLAUD 账号</p><p data-view="account-label">未登录</p><button data-action="account-login">登录 PLAUD</button><button data-action="account-logout" hidden>退出登录</button></div></div><button data-action="workspace-settings">设置</button></div>
    </div>
  </header>
  <div class="library-notice" role="status" aria-live="polite" hidden></div>
  <div class="library-layout">
    <aside class="library-sidebar" aria-label="录音文件">
      <div class="library-sidebar-heading"><h1>录音文件</h1><span data-view="list-total">0</span></div>
      <div class="library-import library-toolbar">
        <div class="library-import-actions"><button class="library-primary" data-action="import">＋ 导入并转写</button><button data-action="import-only">仅导入音频</button></div>
        <input data-field="files" type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac,.aiff" multiple hidden>
        <label>转写语言<select data-field="language"><option value="zh">中文 / 中英混说</option><option value="en">English</option></select></label>
      </div>
      <div class="library-browse-tools">
        <label class="library-scope-label">音频来源<select data-field="source"><option value="all">全部来源</option><option value="import">本机导入</option><option value="ble">PLAUD 录音</option></select></label>
        <input class="library-list-search" data-field="list-search" type="search" placeholder="搜索录音文件…" aria-label="搜索录音标题">
        <div class="library-list-heading"><select class="library-list-filter" data-field="list-filter" aria-label="筛选录音状态"><option value="all">全部录音</option><option value="device">设备待下载</option><option value="local">已保存到本机</option><option value="processing">排队 / 处理中</option><option value="ready">转写完成</option></select><button data-action="trash">回收站</button></div>
      </div>
      <div data-view="list" class="library-file-list" aria-label="录音列表"></div>
      <footer class="library-sidebar-footer"><p data-view="environment" class="library-environment"></p><details class="library-help"><summary>文件与存储说明</summary><p>本机导入：最大 1 GiB / 6 小时。设备下载：源文件最大 256 MiB，默认保留 Ogg。音频与转写文件均保存在项目录音目录中。</p></details></footer>
    </aside>
    <section class="library-detail" aria-label="录音详情">
      <div data-view="empty" class="library-empty"><span class="library-empty-icon">${recordingIcon}</span><p class="library-eyebrow">你的本地录音空间</p><h2>选择一条录音，开始查看</h2><p>从左侧选择录音文件，查看音频与转写正文。<br>也可以导入本机音频，或连接 PLAUD 设备。</p><button data-action="empty-device">连接 PLAUD 设备</button></div>
      <div data-view="device-detail" hidden>
        <header class="library-record-header"><div><p class="library-breadcrumb">录音文件 <span>/ 设备录音</span></p><h2 data-view="device-file-title"></h2><p data-view="device-file-meta"></p></div><span class="library-status">设备录音</span></header>
        <div class="library-record-actions"><button data-action="download-transcribe" class="library-primary">下载并转写</button><button data-action="download-only">仅下载 Ogg</button><button data-action="refresh-device">刷新设备目录</button><button data-action="cancel-transfer" hidden>取消下载</button></div>
        <div class="library-device-progress"><h3>保存到本机</h3><p data-view="device-hint"></p><progress data-view="device-progress" max="100" value="0"></progress><p data-view="device-transfer" role="status"></p><p>完整下载后保存原始文件和 Ogg，按你的选择开始本地转写。下载期间请保持此页面与蓝牙连接。</p></div>
      </div>
      <div data-view="detail" hidden>
        <header class="library-record-header"><div><p class="library-breadcrumb">录音文件 <span>/ 音频与转写</span></p><h2 data-view="title"></h2><p data-view="meta"></p></div><span data-view="status" class="library-status"></span></header>
        <div class="library-record-actions"><button data-action="retry" class="library-primary">开始转写</button><button data-action="cancel">取消处理</button><button data-action="export-current" class="library-primary" hidden>导出文字</button><button data-action="audio">另存音频</button><button data-action="original">下载原件</button><button data-action="rename">修改标题</button><button data-action="delete">移入回收站</button><button data-action="restore">恢复录音</button></div>
        <div data-view="job" class="library-job" role="status"></div>
        <form data-view="rename-form" class="library-rename" hidden><label>录音标题<input data-field="title" maxlength="180" required></label><button class="library-primary" type="submit">保存标题</button><button type="button" data-action="cancel-rename">取消</button></form>
        <details class="library-files"><summary>音频文件与保存位置</summary><div class="library-storage"><code data-view="storage"></code><button data-action="copy-path">复制目录</button></div></details>
        <div data-view="reader" hidden>
          <div class="library-document-heading"><h3>转写正文</h3><span>点击时间回听原音频</span></div>
          <div class="library-document-options">
            <details class="library-export-options"><summary>导出格式与版本</summary><div class="library-export-bar"><label>稿件版本<select data-field="version"><option value="">最新稿件</option></select></label><label>导出格式<select data-field="format"><option value="md">Markdown 全文</option><option value="txt">TXT 全文</option><option value="json">JSON · 全文与核对状态</option><option value="srt">SRT 字幕</option><option value="vtt">VTT 字幕</option></select></label><button data-action="export" class="library-primary">导出当前完整版本</button><span data-view="revision"></span></div></details>
            <details class="library-speakers"><summary>讲话人设置</summary><div data-view="speakers"></div></details>
          </div>
          <div class="library-reader-tools"><input data-field="search" type="search" placeholder="搜索转写正文…" aria-label="搜索转写全文"><select data-field="speaker" aria-label="筛选讲话人"></select><select data-field="mode" aria-label="筛选核对状态"><option value="all">全部段落</option><option value="issues">有疑问</option><option value="unreviewed">未核对</option></select><label><input data-field="follow" type="checkbox" checked>跟随播放</label></div>
          <div data-view="count" class="library-count"></div><div data-view="paragraphs"></div>
          <div class="library-pagination"><button data-action="prev">上一页</button><span data-view="page"></span><button data-action="next">下一页</button></div>
          <p class="library-candidate-note">自动转写候选稿，文字、时间与讲话人需回听核对。修改保存到本机，并保留原始机器稿与历史版本。</p>
        </div>
        <div class="library-player"><div data-view="playtime"></div><audio controls preload="metadata"></audio><div><button data-action="back">−5 秒</button><button data-action="forward">＋5 秒</button><label>速度<select data-field="speed"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div></div>
      </div>
    </section>
  </div>`;
