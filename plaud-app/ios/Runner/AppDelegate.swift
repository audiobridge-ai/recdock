import Flutter
import UIKit
import Security

@main
@objc class AppDelegate: FlutterAppDelegate {
  private var secretChannel: FlutterMethodChannel?
  private var platformChannel: FlutterMethodChannel?
  private var backgroundChannel: FlutterMethodChannel?
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    LocalTranscriptionQueue.shared.initialize()
    GeneratedPluginRegistrant.register(with: self)
    if let controller = window?.rootViewController as? FlutterViewController {
      let service = (Bundle.main.bundleIdentifier ?? "ai.audiobridge.plaudApp") + ".secrets.v1"
      secretChannel = FlutterMethodChannel(name: "ai.audiobridge.recdock/secrets", binaryMessenger: controller.binaryMessenger)
      secretChannel?.setMethodCallHandler { call, result in
        guard let args = call.arguments as? [String: Any], let key = args["key"] as? String,
              key.range(of: "^[a-z0-9_]{1,80}$", options: .regularExpression) != nil else {
          result(FlutterError(code: "SECURE_STORAGE_FAILED", message: "安全存储参数无效", details: nil)); return
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service, kSecAttrAccount as String: key]
        var status: OSStatus = errSecSuccess
        if call.method == "read" {
          var readQuery = query
          readQuery[kSecReturnData as String] = true
          readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
          var data: CFTypeRef?
          status = SecItemCopyMatching(readQuery as CFDictionary, &data)
          if status == errSecItemNotFound { result(nil); return }
          if status == errSecSuccess, let bytes = data as? Data, let value = String(data: bytes, encoding: .utf8) {
            result(value); return
          }
        } else if call.method == "write", let value = args["value"] as? String {
          let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
          status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
          if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
          }
          if status == errSecSuccess { result(nil); return }
        } else if call.method == "delete" {
          status = SecItemDelete(query as CFDictionary)
          if status == errSecSuccess || status == errSecItemNotFound { result(nil); return }
        } else { result(FlutterMethodNotImplemented); return }
        result(FlutterError(code: "SECURE_STORAGE_FAILED", message: "安全存储暂不可用，请重试", details: nil))
      }
      backgroundChannel = FlutterMethodChannel(name: "ai.audiobridge.recdock/background", binaryMessenger: controller.binaryMessenger)
      backgroundChannel?.setMethodCallHandler { call, result in
        do {
          let args = call.arguments as? [String: Any] ?? [:]
          let queue = LocalTranscriptionQueue.shared
          switch call.method {
          case "activate": queue.activate(args["namespace"] as? String ?? ""); result(nil)
          case "enqueue":
            guard let text = args["json"] as? String, let data = text.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "queue", code: 1) }
            try queue.enqueue(json); result(nil)
          case "snapshot": result(try queue.snapshot())
          case "cancel", "ack": try queue.remove(args["id"] as? String ?? "", ack: call.method == "ack"); result(nil)
          case "foreground": queue.lifecycle(args["value"] as? Bool ?? false); result(nil)
          case "notifications": UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in DispatchQueue.main.async { result(granted) } }
          default: result(FlutterMethodNotImplemented)
          }
        } catch { result(FlutterError(code: "BACKGROUND_TASK_FAILED", message: "后台任务暂不可用，原文件和任务记录已保留", details: nil)) }
      }
      platformChannel = FlutterMethodChannel(name: "ai.audiobridge.recdock/platform", binaryMessenger: controller.binaryMessenger)
      platformChannel?.setMethodCallHandler { call, result in
        if call.method == "shareTranscript" {
          guard let args = call.arguments as? [String: Any], let path = args["path"] as? String else {
            result(FlutterError(code: "EXPORT_SHARE_FAILED", message: "分享文件无效", details: nil)); return
          }
          let file = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
          let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
          let root = cache.appendingPathComponent("transcript-exports", isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
          guard file.deletingLastPathComponent().path == root.path,
                file.lastPathComponent.range(of: "^transcript-[a-f0-9]+\\.(md|txt|json|srt|vtt)$", options: .regularExpression) != nil,
                FileManager.default.fileExists(atPath: file.path) else {
            result(FlutterError(code: "EXPORT_SHARE_FAILED", message: "分享文件无效", details: nil)); return
          }
          let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
          if let popover = activity.popoverPresentationController {
            popover.sourceView = controller.view
            popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
          }
          controller.present(activity, animated: true) { result(nil) }
        } else if call.method == "freeDiskBytes" {
          do {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            result(values.volumeAvailableCapacityForImportantUsage)
          } catch { result(FlutterError(code: "STORAGE_UNAVAILABLE", message: "无法读取可用空间", details: nil)) }
        } else { result(FlutterMethodNotImplemented) }
      }
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
  override func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    if identifier == LocalTranscriptionQueue.sessionID { LocalTranscriptionQueue.shared.completion = completionHandler }
    else { super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler) }
  }
}

// The durable queue is independent of Flutter routes and the Dart isolate.
// URLSession owns file transfers; BGAppRefresh supplies opportunistic status sync.
import BackgroundTasks
import UserNotifications
import CryptoKit

final class LocalTranscriptionQueue: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
  static let shared = LocalTranscriptionQueue()
  static let refreshID = "ai.audiobridge.plaudApp.transcription.refresh"
  static let sessionID = "ai.audiobridge.plaudApp.transcription.upload.v1"
  var completion: (() -> Void)?
  private var jobs: [String: [String: Any]] = [:]
  private var buffers: [Int: Data] = [:]
  private var active: [Int: String] = [:]
  private var foreground = true
  private var namespace = UserDefaults.standard.string(forKey: "transcription-namespace") ?? ""
  private var ready = false
  private var corruptIDs = Set<String>()
  private var refreshCompletion: (() -> Void)?
  private var refreshTasks = 0
  private let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("transcription-queue-v1", isDirectory: true)
  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
    c.sessionSendsLaunchEvents = true; c.isDiscretionary = false
    c.timeoutIntervalForRequest = 60; c.timeoutIntervalForResource = 60 * 60
    c.httpMaximumConnectionsPerHost = 1
    return URLSession(configuration: c, delegate: self, delegateQueue: .main)
  }()
  private func file(_ id: String, _ ext: String = "json") -> URL { root.appendingPathComponent(id + "." + ext) }
  private func keyName(_ id: String) -> String { "bg_" + SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() }
  private func key(_ id: String, value: String? = nil, delete: Bool = false) throws -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "") + ".background.v1", kSecAttrAccount as String: keyName(id)]
    if delete { let s = SecItemDelete(q as CFDictionary); guard s == errSecSuccess || s == errSecItemNotFound else { throw failure() }; return nil }
    if let value = value {
      let a: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
      var s = SecItemUpdate(q as CFDictionary, a as CFDictionary)
      if s == errSecItemNotFound { s = SecItemAdd(q.merging(a) { _, b in b } as CFDictionary, nil) }
      guard s == errSecSuccess else { throw failure() }; return nil
    }
    var r = q; r[kSecReturnData as String] = true; r[kSecMatchLimit as String] = kSecMatchLimitOne
    var d: CFTypeRef?; guard SecItemCopyMatching(r as CFDictionary, &d) == errSecSuccess, let data = d as? Data else { throw failure() }
    return String(data: data, encoding: .utf8)
  }
  private func failure() -> NSError { NSError(domain: "LocalTranscriptionQueue", code: 1) }
  private func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
  private func save(_ j: [String: Any]) throws { try JSONSerialization.data(withJSONObject: j).write(to: file(j["id"] as! String), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); jobs[j["id"] as! String] = j }
  func initialize() {
    guard !ready else { return }; ready = true
    do {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      for f in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where f.pathExtension == "json" {
        if let j = try? JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [String: Any], let id = j["id"] as? String, id == f.deletingPathExtension().lastPathComponent, j["state"] != nil, j["namespace"] != nil { jobs[id] = j }
        else { corruptIDs.insert(f.deletingPathExtension().lastPathComponent) }
      }
    } catch { }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshID, using: .main) { task in
      guard let task = task as? BGAppRefreshTask else { return }
      self.refreshCompletion = { task.setTaskCompleted(success: true) }
      task.expirationHandler = { DispatchQueue.main.async { self.refreshCompletion?(); self.refreshCompletion = nil } }
      self.pump(); self.poll(); self.scheduleRefresh()
      if self.refreshTasks == 0 { self.refreshCompletion?(); self.refreshCompletion = nil }
    }
    session.getAllTasks { tasks in DispatchQueue.main.async {
      for t in tasks { if let id = t.taskDescription { self.active[t.taskIdentifier] = id } }
      for (id, var j) in self.jobs where !self.active.values.contains(id) {
        if j["state"] as? String == "submitting" { j["state"] = j["remoteId"] is String ? "queued" : "uncertain"; j["notice"] = "提交记录已恢复，不会自动重复提交"; try? self.save(j) }
        if j["state"] as? String == "uploading" { j["state"] = "interrupted"; j["notice"] = "后台上传已停止，返回后可再次确认重试"; try? self.save(j) }
      }
      self.pump()
    } }
  }
  func activate(_ value: String) {
    if namespace != value {
      let previous = Set(jobs.values.filter { $0["namespace"] as? String == namespace }.compactMap { $0["id"] as? String })
      session.getAllTasks { tasks in tasks.filter { previous.contains($0.taskDescription ?? "") }.forEach { $0.cancel() } }
    }
    namespace = value; UserDefaults.standard.set(value, forKey: "transcription-namespace")
  }
  func enqueue(_ input: [String: Any]) throws {
    var j = input
    guard let id = j["id"] as? String, matches(id, "^job_[a-f0-9]+$"), j["namespace"] as? String == namespace, !namespace.isEmpty else { throw failure() }
    guard !corruptIDs.contains(id) else { throw failure() }
    if jobs[id] != nil { return }
    guard let path = j["audioPath"] as? String, let secret = j["apiKey"] as? String, matches(secret, "^[A-Za-z0-9_-]{16,256}$"), ["us", "eu"].contains(j["region"] as? String ?? "") else { throw failure() }
    let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
    guard url.path.hasPrefix(URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"), FileManager.default.fileExists(atPath: url.path), let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 1073741824 else { throw failure() }
    if let base = j["testBase"] as? String, !base.isEmpty {
      #if DEBUG
      guard let u = URL(string: base), u.scheme == "http", ["localhost", "127.0.0.1"].contains(u.host ?? "") else { throw failure() }
      #else
      throw failure()
      #endif
    }
    _ = try key(id, value: secret); j.removeValue(forKey: "apiKey"); j["state"] = "waiting_upload"; j["audioPath"] = url.path
    try save(j); pump()
  }
  func snapshot() throws -> String {
    pump(); if foreground { poll() }
    let own = try jobs.values.filter { $0["namespace"] as? String == namespace }.map { j -> [String: Any] in
      var copy = j; copy.removeValue(forKey: "audioPath")
      if j["state"] as? String == "syncing" { copy["result"] = try JSONSerialization.jsonObject(with: Data(contentsOf: file(j["id"] as! String, "result"))) }
      return copy
    }
    return String(data: try JSONSerialization.data(withJSONObject: own), encoding: .utf8)!
  }
  func remove(_ id: String, ack: Bool) throws {
    guard var j = jobs[id], j["namespace"] as? String == namespace else { throw failure() }
    if ack {
      guard ["syncing", "error", "uncertain", "cancelled", "interrupted", "queued", "processing"].contains(j["state"] as? String ?? "") else { throw failure() }
      try FileManager.default.removeItem(at: file(id)); try? FileManager.default.removeItem(at: file(id, "result")); jobs.removeValue(forKey: id)
    } else {
      guard ["waiting_upload", "uploading", "uploaded"].contains(j["state"] as? String ?? "") else { throw failure() }
      j["state"] = "cancelled"; try save(j)
      session.getAllTasks { tasks in tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
    }
    _ = try key(id, delete: true); pump()
  }
  func lifecycle(_ visible: Bool) { foreground = visible; if visible { pump(); poll() } else { scheduleRefresh() } }
  private func own() -> [[String: Any]] { jobs.values.filter { $0["namespace"] as? String == namespace && !namespace.isEmpty }.sorted { ($0["createdAt"] as? Int ?? 0) < ($1["createdAt"] as? Int ?? 0) } }
  private func base(_ j: [String: Any]) throws -> String {
    if let test = j["testBase"] as? String {
      #if DEBUG
      guard let u = URL(string: test), u.scheme == "http", ["localhost", "127.0.0.1"].contains(u.host ?? "") else { throw failure() }
      return test
      #else
      throw failure()
      #endif
    }
    return (j["region"] as? String == "eu") ? "https://api.eu.assemblyai.com" : "https://api.assemblyai.com"
  }
  private func validUpload(_ text: String) -> Bool { guard let u = URL(string: text) else { return false }; return u.scheme == "https" && ["cdn.assemblyai.com", "cdn.eu.assemblyai.com"].contains(u.host ?? "") && u.port == nil && u.user == nil && u.fragment == nil && u.path.hasPrefix("/upload/") }
  private func request(_ j: [String: Any], path: String, method: String = "GET") throws -> URLRequest {
    let endpoint = try base(j)
    guard let url = URL(string: endpoint + path) else { throw failure() }
    var r = URLRequest(url: url); r.httpMethod = method
    r.setValue(try key(j["id"] as! String), forHTTPHeaderField: "Authorization"); r.setValue("application/json", forHTTPHeaderField: "Accept"); return r
  }
  private func pump() {
    let own = own()
    guard !own.isEmpty, !own.contains(where: { ["uploading", "submitting"].contains($0["state"] as? String ?? "") }) else { return }
    let slots = own.filter { ["queued", "processing", "uncertain"].contains($0["state"] as? String ?? "") }.count
    guard slots < 2, var j = own.first(where: { ["waiting_upload", "uploaded"].contains($0["state"] as? String ?? "") }) else { return }
    let id = j["id"] as! String
    do {
      let upload = j["state"] as? String == "waiting_upload"
      var r = try request(j, path: upload ? "/v2/upload" : "/v2/transcript", method: "POST")
      let source: URL
      if upload { source = URL(fileURLWithPath: j["audioPath"] as! String); r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type") }
      else {
        var b: [String: Any] = ["audio_url": j["uploadUrl"]!, "speech_models": j["models"]!, "speaker_labels": true, "punctuate": true, "format_text": true]
        if j["language"] as? String == "auto" { b["language_detection"] = true } else { b["language_code"] = j["language"] }
        source = file(id, "body"); try JSONSerialization.data(withJSONObject: b).write(to: source, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      j["state"] = upload ? "uploading" : "submitting"; try save(j)
      let t = session.uploadTask(with: r, fromFile: source); t.taskDescription = id; active[t.taskIdentifier] = id; t.resume()
    } catch { j["state"] = "error"; j["notice"] = "任务无法启动，原文件已保留"; try? save(j) }
  }
  func poll() {
    for j in own() where ["queued", "processing"].contains(j["state"] as? String ?? "") && (j["retryAt"] as? Double ?? 0) <= Date().timeIntervalSince1970 * 1000 {
      let id = j["id"] as! String
      guard !active.values.contains(id), let remote = j["remoteId"] as? String, matches(remote, "^[a-zA-Z0-9_-]{1,160}$"), let r = try? request(j, path: "/v2/transcript/" + remote) else { continue }
      refreshTasks += 1
      let t = URLSession.shared.dataTask(with: r) { data, response, error in DispatchQueue.main.async {
        defer { self.refreshTasks -= 1; if self.refreshTasks == 0 { self.refreshCompletion?(); self.refreshCompletion = nil } }
        self.finish(id, data: data, response: response, error: error)
      } }
      // Track the ID separately from background task identifiers.
      active[-t.taskIdentifier - 1] = id; t.resume()
    }
  }
  private func finish(_ id: String, data: Data?, response: URLResponse?, error: Error?) {
    active = active.filter { $0.value != id }
    guard var j = jobs[id], j["state"] as? String != "cancelled" else { return }
    guard j["namespace"] as? String == namespace else {
      if j["state"] as? String == "submitting" { j["state"] = "uncertain"; try? save(j) }
      if j["state"] as? String == "uploading" { j["state"] = "interrupted"; try? save(j) }
      return
    }
    let state = j["state"] as? String ?? ""
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    do {
      guard error == nil, status >= 200 && status < 300, let data = data, data.count <= 33554432, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure() }
      if state == "uploading" {
        guard let url = result["upload_url"] as? String, validUpload(url) else { throw failure() }
        j["uploadUrl"] = url; j["state"] = "uploaded"; j["progress"] = 1
      } else {
        if state == "submitting" { guard let remote = result["id"] as? String, matches(remote, "^[a-zA-Z0-9_-]{1,160}$") else { throw failure() }; j["remoteId"] = remote; try save(j) }
        guard result["id"] as? String == j["remoteId"] as? String, result["audio_url"] == nil || result["audio_url"] is NSNull || result["audio_url"] as? String == j["uploadUrl"] as? String, let phase = result["status"] as? String, ["queued", "processing", "completed", "error"].contains(phase) else { throw failure() }
        if phase == "completed" { try data.write(to: file(id, "result"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); j["state"] = "syncing" } else { j["state"] = phase }
        j["retryAt"] = Int(Date().addingTimeInterval(15).timeIntervalSince1970 * 1000)
        if ["completed", "error"].contains(phase) { notify(id, success: phase == "completed") }
      }
      j.removeValue(forKey: "notice"); try save(j)
    } catch {
      if state == "submitting" { j["state"] = [400, 401, 403, 404, 413, 415, 422, 429].contains(status) ? "error" : "uncertain"; j["notice"] = "提交未能确认，请核对控制台，避免重复计费" }
      else if state == "uploading" { j["state"] = "interrupted"; j["notice"] = "上传未完成，原文件已保留，可再次确认后重试" }
      else { j["notice"] = "查询暂不可用，云端任务 ID 已保留" }
      let retry = min(900, max(15, Double((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60))
      j["retryAt"] = Int(Date().addingTimeInterval(retry).timeIntervalSince1970 * 1000); try? save(j)
    }
    try? FileManager.default.removeItem(at: file(id, "body")); pump(); scheduleRefresh()
  }
  private func scheduleRefresh() {
    guard own().contains(where: { ["queued", "processing", "waiting_upload", "uploaded"].contains($0["state"] as? String ?? "") }) else { return }
    let r = BGAppRefreshTaskRequest(identifier: Self.refreshID); r.earliestBeginDate = Date().addingTimeInterval(15 * 60); try? BGTaskScheduler.shared.submit(r)
  }
  private func notify(_ id: String, success: Bool) {
    let c = UNMutableNotificationContent(); c.title = success ? "转写已完成" : "转写需要处理"; c.body = "打开 RecDock 查看任务状态"; c.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if (buffers[dataTask.taskIdentifier]?.count ?? 0) + data.count > 33554432 { dataTask.cancel(); return }
    buffers[dataTask.taskIdentifier, default: Data()].append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    guard let id = task.taskDescription, var j = jobs[id], j["state"] as? String == "uploading", totalBytesExpectedToSend > 0 else { return }
    j["progress"] = Double(totalBytesSent) / Double(totalBytesExpectedToSend); try? save(j)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }; finish(id, data: buffers.removeValue(forKey: task.taskIdentifier), response: task.response, error: error)
  }
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) { }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { let c = completion; completion = nil; c?() }
}
