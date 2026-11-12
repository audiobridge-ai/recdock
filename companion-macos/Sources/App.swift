import AppKit
import ServiceManagement

final class CompanionApp: NSObject, NSApplicationDelegate {
    private var runtime: CompanionRuntime!
    private var item: NSStatusItem!
    private var window: NSWindow!
    private var statusLabel = NSTextField(wrappingLabelWithString: "正在启动…")
    private var modelLabel = NSTextField(wrappingLabelWithString: "准备本地处理环境后，就可以离线转写录音。")
    private var locationLabel = NSTextField(wrappingLabelWithString: "")
    private var websites = NSStackView()
    private var credential = NSSecureTextField()
    private var login = NSButton(checkboxWithTitle: "登录 Mac 后自动启动", target: nil, action: nil)
    private var currentStatus: DesktopStatus?
    private var timer: Timer?
    private var quitting = false
    private var restartRequested = false
    private var pendingPreparation: Bool?
    private var polling = false
    private var modelButtons: [NSButton] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        do { runtime = try CompanionRuntime() }
        catch { showFatal(error); return }
        runtime.onChange = { [weak self] text in self?.statusLabel.stringValue = text }
        runtime.onStopped = { [weak self] in self?.didStop() }
        buildMenu(); buildWindow()
        start()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        showWindow()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { $0.scheme == "recdock" && $0.host == "open" }) { showWindow() }
    }

    private func showFatal(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "RecDock 无法启动"; alert.informativeText = error.localizedDescription
        alert.runModal(); NSApp.terminate(nil)
    }
    private func explain(_ text: String) { statusLabel.stringValue = text }
    private func finishQuit() { if quitting && !runtime.isRunning && !runtime.isPreparing { NSApp.reply(toApplicationShouldTerminate: true) } }
    private func didStop() {
        if quitting { finishQuit() }
        else if let verifyOnly = pendingPreparation { pendingPreparation = nil; launchPreparation(verifyOnly: verifyOnly) }
        else if restartRequested { restartRequested = false; start() }
    }
    private func action(_ title: String, _ selector: Selector) -> NSButton { let b = NSButton(title: title, target: self, action: selector); b.bezelStyle = .rounded; return b }
    private func text(_ value: String, size: CGFloat = 13, bold: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        field.preferredMaxLayoutWidth = 620
        field.widthAnchor.constraint(lessThanOrEqualToConstant: 620).isActive = true
        return field
    }
    private func row(_ views: [NSView]) -> NSStackView { let v = NSStackView(views: views); v.orientation = .horizontal; v.spacing = 10; v.alignment = .centerY; return v }
    private func section(_ title: String, _ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: [text(title, size: 17, bold: true)] + views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 13; stack.edgeInsets = NSEdgeInsets(top: 24, left: 26, bottom: 24, right: 26)
        return stack
    }
    private func tab(_ title: String, view: NSView) -> NSTabViewItem { let item = NSTabViewItem(identifier: title); item.label = title; item.view = view; return item }

    private func buildMenu() {
        let main = NSMenu(), applicationItem = NSMenuItem(), applicationMenu = NSMenu()
        let quitItem = NSMenuItem(title: "退出 RecDock", action: #selector(quit), keyEquivalent: "q"); quitItem.target = self
        applicationMenu.addItem(quitItem); applicationItem.submenu = applicationMenu; main.addItem(applicationItem); NSApp.mainMenu = main
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "RecDock 本地助手")
        let menu = NSMenu()
        for (title, selector) in [("打开 RecDock 助手", #selector(showWindow)), ("打开录音工作台", #selector(openWorkspace)), ("启动后台服务", #selector(start)), ("停止后台服务", #selector(stop)), ("退出 RecDock", #selector(quit))] {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: ""); entry.target = self; menu.addItem(entry)
        }
        item.menu = menu
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 570), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "RecDock 本地助手"; window.isReleasedWhenClosed = false; window.center()
        let tabs = NSTabView(frame: NSRect(x: 15, y: 15, width: 710, height: 540))
        tabs.autoresizingMask = [.width, .height]
        statusLabel.font = .systemFont(ofSize: 14); statusLabel.maximumNumberOfLines = 3
        for field in [statusLabel, modelLabel, locationLabel] { field.preferredMaxLayoutWidth = 620; field.widthAnchor.constraint(lessThanOrEqualToConstant: 620).isActive = true }
        login.target = self; login.action = #selector(toggleLogin); login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        let overview = section("让录音留在你的 Mac", [
            text("网页负责浏览与校对，这个助手负责存储、转写和持续处理任务。", size: 14), statusLabel,
            row([action("打开录音工作台", #selector(openWorkspace)), action("启动服务", #selector(start)), action("停止服务", #selector(stop)), action("退出助手", #selector(quit))]),
            text("工作台网站：\n" + runtime.webURL.absoluteString),
            text("录音资料：\n" + runtime.support.appendingPathComponent("library").path),
            action("在访达中打开资料目录", #selector(revealData)), login,
            text("关闭这个窗口或网页，后台任务仍会继续。退出菜单栏助手时会暂停处理；重新启动后恢复未完成任务。"),
            text("卸载：先关闭自动启动并退出助手，再移除 RecDock.app。录音与模型保留在上述用户目录，不会自动删除。")
        ])
        tabs.addTabViewItem(tab("概览", view: overview))
        locationLabel.stringValue = "模型目录：" + runtime.models.path
        locationLabel.maximumNumberOfLines = 2
        credential.placeholderString = "Hugging Face 只读访问令牌（讲话人模型需要）"
        credential.translatesAutoresizingMaskIntoConstraints = false; credential.widthAnchor.constraint(equalToConstant: 620).isActive = true
        let prepare = action("准备 / 继续下载模型", #selector(prepareModels)), verify = action("校验已有模型", #selector(verifyModels)), check = action("检查处理环境", #selector(checkEnvironment))
        modelButtons = [prepare, verify, check]
        let models = section("首次准备本地模型", [
            text("App 已自带处理运行时。模型单独保存，首次下载约需数 GB 空间；下载中断后可继续。"), locationLabel,
            row([action("选择已有模型目录…", #selector(selectModels)), action("打开模型授权页面", #selector(openModelTerms))]),
            text("讲话人模型需先在 Hugging Face 官方页面获得访问许可。助手不会代你接受条款。令牌仅保存在本机钥匙串，用于下载模型。"),
            credential,
            row([action("保存模型授权", #selector(saveCredential)), action("移除已保存授权", #selector(removeCredential))]),
            row([prepare, verify, check, action("取消准备", #selector(cancelPreparation))]), modelLabel,
            text("已有模型可以直接选择并校验，无需重新下载。导入和保存音频不要求模型就绪；开始转写前需要完成全部检查。")
        ])
        tabs.addTabViewItem(tab("模型准备", view: models))
        websites.orientation = .vertical; websites.alignment = .leading; websites.spacing = 12
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.documentView = websites
        websites.translatesAutoresizingMaskIntoConstraints = false
        websites.widthAnchor.constraint(equalTo: scroll.widthAnchor, constant: -24).isActive = true
        scroll.translatesAutoresizingMaskIntoConstraints = false; scroll.heightAnchor.constraint(equalToConstant: 300).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: 620).isActive = true
        let grants = section("允许哪些网站访问本机录音", [text("在网页点击“连接 Mac 助手”，再在这里核对完整网站地址并批准。授权有效期为 30 天，可随时撤销。"), scroll, action("打开备用配对码页面", #selector(openPairing)), text("授权包括读取和管理本机录音、转写与设备账号。只批准你信任的 RecDock 工作台；后台管理入口不会开放给网页。")])
        tabs.addTabViewItem(tab("网站授权", view: grants))
        window.contentView?.addSubview(tabs)
    }

    @objc func showWindow() { guard window != nil else { return }; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func openWorkspace() { NSWorkspace.shared.open(runtime.webURL) }
    @objc func openPairing() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:43127/")!) }
    @objc func revealData() { NSWorkspace.shared.open(runtime.support) }
    @objc func start() { do { try runtime.start() } catch { explain(error.localizedDescription) } }
    @objc func stop() { runtime.stop() }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func toggleLogin() {
        do {
            if login.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            if SMAppService.mainApp.status == .requiresApproval { explain("请在系统设置 → 通用 → 登录项中批准 RecDock。") }
        } catch { login.state = SMAppService.mainApp.status == .enabled ? .on : .off; explain("自动启动设置未完成：" + error.localizedDescription) }
    }
    @objc func selectModels() {
        guard !runtime.isPreparing else { return }
        let picker = NSOpenPanel(); picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false; picker.prompt = "选择模型目录"
        guard picker.runModal() == .OK, let directory = picker.url else { return }
        do {
            guard (currentStatus?.environment?.activeJobs ?? 0) == 0 else { throw CompanionFailure.message("请等待正在处理的任务完成后再切换模型。") }
            try runtime.selectModels(directory); locationLabel.stringValue = "模型目录：" + directory.path
            if runtime.isRunning { restartRequested = true; runtime.stop() }
            modelLabel.stringValue = "已选择模型目录，请点击“校验已有模型”。"
        } catch { modelLabel.stringValue = error.localizedDescription }
    }
    @objc func openModelTerms() { NSWorkspace.shared.open(URL(string: "https://huggingface.co/pyannote/speaker-diarization-community-1")!) }
    @objc func saveCredential() {
        let value = credential.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("hf_"), value.count >= 10, !value.contains(where: { $0.isWhitespace }) else { modelLabel.stringValue = "请输入有效的 Hugging Face 只读令牌。"; return }
        do { try ModelCredential.save(value); credential.stringValue = ""; modelLabel.stringValue = "模型下载授权已保存在本机钥匙串。" } catch { modelLabel.stringValue = error.localizedDescription }
    }
    @objc func removeCredential() { do { try ModelCredential.remove(); credential.stringValue = ""; modelLabel.stringValue = "已移除保存的模型下载授权，已有模型不受影响。" } catch { modelLabel.stringValue = error.localizedDescription } }
    @objc func cancelPreparation() { runtime.cancelPreparation(); modelLabel.stringValue = "正在取消；已下载部分将保留。" }
    @objc func prepareModels() { prepare(verifyOnly: false) }
    @objc func verifyModels() { prepare(verifyOnly: true) }

    private func prepare(verifyOnly: Bool) {
        guard !runtime.isPreparing else { return }
        guard (currentStatus?.environment?.activeJobs ?? 0) == 0 else { modelLabel.stringValue = "请先等待正在进行的转写任务完成。"; return }
        let free = (try? runtime.support.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? 0
        guard verifyOnly || free > 8 * 1024 * 1024 * 1024 else { modelLabel.stringValue = "可用磁盘空间不足，请至少预留 8 GB 后再准备模型。"; return }
        if runtime.isRunning {
            pendingPreparation = verifyOnly
            runtime.stop()
        } else { launchPreparation(verifyOnly: verifyOnly) }
    }

    private func launchPreparation(verifyOnly: Bool) {
        var args = ["-m", "recdock_audio.models", "--root", runtime.models.path]
        if verifyOnly { args.append("--verify") }
        modelLabel.stringValue = verifyOnly ? "正在校验模型文件与完整性…" : "正在准备模型，可以关闭窗口，保持菜单栏助手运行。"
        do {
            try runtime.runPython(args, token: verifyOnly ? nil : ModelCredential.load(), progress: { [weak self] text in self?.modelLabel.stringValue = text }) { [weak self] code, data in
                guard let self = self else { return }
                self.modelLabel.stringValue = code == 0 ? "模型文件校验通过。接下来点击“检查处理环境”验证计算设备。" : self.modelFailure(data)
                if self.quitting { self.finishQuit() } else { self.start() }
            }
        } catch { modelLabel.stringValue = error.localizedDescription; start() }
    }

    private func modelFailure(_ data: Data) -> String {
        let output = String(decoding: data, as: UTF8.self)
        if output.contains("HF_LOGIN_REQUIRED") { return "讲话人模型需要下载授权。请打开官方模型页面获得许可，并保存只读令牌后重试。" }
        if output.contains("MODEL_ACCESS_DENIED") { return "模型访问未获许可，请检查官方页面授权与令牌权限。已有下载已保留。" }
        if output.contains("HASH_MISMATCH") || output.contains("MANIFEST_MISMATCH") { return "模型完整性校验失败，请重新准备模型；助手不会使用校验失败的文件。" }
        return "模型准备尚未完成，请检查网络、模型目录与官方访问授权后重试。已下载部分会保留。"
    }

    @objc func checkEnvironment() {
        guard !runtime.isPreparing else { return }
        modelLabel.stringValue = "正在检查 Python、音频工具与 Metal 设备…"
        do {
            try runtime.runPython(["-m", "recdock_audio.preflight", "environment", "--workspace", runtime.support.path, "--accelerators"], progress: { _ in }) { [weak self] code, data in
                guard let self = self else { return }
                if code == 0, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let blockers = value["blockers"] as? [String] {
                    self.modelLabel.stringValue = blockers.isEmpty ? "处理环境检查通过，Metal 可用。模型校验通过后即可开始转写。" : "处理环境尚未就绪：" + blockers.joined(separator: "、")
                } else { self.modelLabel.stringValue = "处理环境检查未完成，请重新安装完整的助手运行时后重试。" }
                if self.quitting { self.finishQuit() }
            }
        } catch { modelLabel.stringValue = error.localizedDescription }
    }

    private func refresh() {
        modelButtons.forEach { $0.isEnabled = !runtime.isPreparing }
        guard runtime.isRunning, !polling else { return }; polling = true
        runtime.readStatus { [weak self] result in
            guard let self = self else { return }; self.polling = false
            switch result {
            case .success(let status):
                self.currentStatus = status
                self.statusLabel.stringValue = "后台服务正在运行 · " + String(status.environment?.activeJobs ?? 0) + " 个任务处理中"
                self.item.button?.toolTip = status.pending.isEmpty ? "RecDock 正在运行" : "RecDock 有网站等待授权"
                self.renderWebsites(status)
            case .failure: self.statusLabel.stringValue = "正在等待本机服务响应；若持续无响应，请停止后重新启动。"
            }
        }
    }
    private var websiteSnapshot = ""
    private func renderWebsites(_ status: DesktopStatus) {
        let snapshot = status.pending.map { $0.id }.joined() + status.grants.map { $0.id }.joined()
        guard snapshot != websiteSnapshot || websites.arrangedSubviews.isEmpty else { return }; websiteSnapshot = snapshot
        websites.arrangedSubviews.forEach { websites.removeArrangedSubview($0); $0.removeFromSuperview() }
        if status.pending.isEmpty && status.grants.isEmpty { websites.addArrangedSubview(text("暂无授权。打开网页并点击“连接 Mac 助手”后，请求会显示在这里。")) }
        for pending in status.pending {
            let allow = action("允许", #selector(decideWebsite(_:))), deny = action("拒绝", #selector(decideWebsite(_:)))
            allow.identifier = NSUserInterfaceItemIdentifier("allow:" + pending.id); deny.identifier = NSUserInterfaceItemIdentifier("deny:" + pending.id)
            websites.addArrangedSubview(text("请求访问：" + pending.origin, bold: true)); websites.addArrangedSubview(row([allow, deny]))
        }
        for grant in status.grants {
            let revoke = action("撤销授权", #selector(revokeWebsite(_:))); revoke.identifier = NSUserInterfaceItemIdentifier(grant.id)
            websites.addArrangedSubview(text("已授权：" + grant.origin)); websites.addArrangedSubview(revoke)
        }
    }
    @objc func decideWebsite(_ sender: NSButton) {
        guard let value = sender.identifier?.rawValue, let split = value.firstIndex(of: ":") else { return }
        sender.isEnabled = false
        runtime.request("decision", value: ["id": String(value[value.index(after: split)...]), "approve": value.hasPrefix("allow:")]) { [weak self] result in if case .failure(let error) = result { self?.explain(error.localizedDescription) }; self?.refresh() }
    }
    @objc func revokeWebsite(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }; sender.isEnabled = false
        runtime.request("revoke", value: ["id": id]) { [weak self] result in if case .failure(let error) = result { self?.explain(error.localizedDescription) }; self?.refresh() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard runtime != nil else { return .terminateNow }
        quitting = true; timer?.invalidate()
        if runtime.isPreparing || runtime.isRunning { runtime.cancelPreparation(); runtime.stop(); return .terminateLater }
        return .terminateNow
    }
}
