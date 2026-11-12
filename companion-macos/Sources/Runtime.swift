import Foundation
import Security

struct CompanionSettings: Codable {
    var modelsDirectory: String?
}

struct PendingAuthorization: Decodable { let id: String; let origin: String; let expires: Double }
struct WebsiteGrant: Decodable { let id: String; let origin: String; let expires: Double }
struct DesktopStatus: Decodable {
    struct Environment: Decodable { let available: Bool; let missing: [String]; let activeJobs: Int; let storageRoot: String }
    let product: String
    let pending: [PendingAuthorization]
    let grants: [WebsiteGrant]
    let environment: Environment?
}

enum CompanionFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

final class CompanionRuntime {
    let resources: URL
    let support: URL
    let webURL: URL
    private(set) var process: Process?
    private(set) var task: Process?
    private(set) var settings = CompanionSettings()
    private let control: String
    private let session: URLSession
    var onChange: ((String) -> Void)?
    var onStopped: (() -> Void)?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var taskPipes: [Pipe] = []
    private var taskOutput = Data()

    init(resources: URL = Bundle.main.resourceURL!, support: URL? = nil) throws {
        self.resources = resources
        self.support = support ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/RecDock", isDirectory: true)
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("companion.json"))) as? [String: Any]
        guard let text = config?["webOrigin"] as? String, let url = URL(string: text), url.scheme == "https", url.host != nil, url.path.isEmpty, url.query == nil, url.fragment == nil, url.user == nil else { throw CompanionFailure.message("工作台地址配置不正确。") }
        webURL = url
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CompanionFailure.message("无法创建本机管理凭据。") }
        control = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
        try FileManager.default.createDirectory(at: self.support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.support.path)
        let file = self.support.appendingPathComponent("settings.json")
        if FileManager.default.fileExists(atPath: file.path) { settings = try JSONDecoder().decode(CompanionSettings.self, from: Data(contentsOf: file)) }
    }

    var models: URL { settings.modelsDirectory.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? support.appendingPathComponent("models", isDirectory: true) }
    var workspace: URL { resources.appendingPathComponent("workspace", isDirectory: true) }
    var python: URL { resources.appendingPathComponent("runtime/python/bin/python3.11") }
    var isRunning: Bool { process?.isRunning == true }
    var isPreparing: Bool { task?.isRunning == true }

    func selectModels(_ directory: URL) throws {
        guard !isPreparing else { throw CompanionFailure.message("模型正在准备，请等待完成后再切换。") }
        settings.modelsDirectory = directory.path
        let file = support.appendingPathComponent("settings.json")
        try JSONEncoder().encode(settings).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    func environment() -> [String: String] {
        ["PATH": resources.appendingPathComponent("runtime/bin").path + ":/usr/bin:/bin:/usr/sbin:/sbin",
         "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
         "PYTHONPATH": workspace.appendingPathComponent("worker").path, "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
         "HF_HOME": support.appendingPathComponent("huggingface").path,
         "HF_HUB_DISABLE_XET": "1", "HF_HUB_DOWNLOAD_TIMEOUT": "60", "HF_HUB_ETAG_TIMEOUT": "30",
         "XDG_CACHE_HOME": support.appendingPathComponent("cache").path,
         "MPLCONFIGDIR": support.appendingPathComponent("matplotlib").path,
         "RECDOCK_LIBRARY_DIR": support.appendingPathComponent("library").path,
         "RECDOCK_VAULT_FILE": support.appendingPathComponent("vault/accounts.json").path,
         "RECDOCK_AUDIO_PYTHON": python.path, "RECDOCK_AUDIO_MODELS": models.path,
         "RECDOCK_FFMPEG": resources.appendingPathComponent("runtime/bin/ffmpeg").path,
         "RECDOCK_FFPROBE": resources.appendingPathComponent("runtime/bin/ffprobe").path,
         "RECDOCK_BROADCAST_HELPER": resources.appendingPathComponent("native/BroadcastScanner.app/Contents/MacOS/BroadcastScanner").path,
         "RECDOCK_FILELOCK_HELPER": resources.appendingPathComponent("native/FileLock").path,
         "RECDOCK_TRUST_FILE": support.appendingPathComponent("trust/grants.json").path,
         "RECDOCK_WEB_ORIGINS": webURL.absoluteString, "RECDOCK_CONTROL_TOKEN": control]
    }

    func start() throws {
        guard !isRunning else { return }
        guard !isPreparing else { throw CompanionFailure.message("正在准备模型，完成后会启动后台服务。") }
        let child = Process(), output = Pipe(), errors = Pipe()
        child.executableURL = resources.appendingPathComponent("runtime/node")
        child.arguments = [workspace.appendingPathComponent("server/companion/main.js").path]
        child.currentDirectoryURL = workspace
        child.environment = environment()
        child.standardInput = FileHandle.nullDevice; child.standardOutput = output; child.standardError = errors
        output.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        child.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                self?.outputPipe?.fileHandleForReading.readabilityHandler = nil
                self?.errorPipe?.fileHandleForReading.readabilityHandler = nil
                self?.process = nil
                self?.onChange?(process.terminationStatus == 0 ? "后台服务已停止；录音和任务已保留。" : "后台服务启动失败或异常退出，请检查端口是否被其他 RecDock 服务占用。")
                self?.onStopped?()
            }
        }
        process = child; outputPipe = output; errorPipe = errors
        do { try child.run(); onChange?("正在启动本地服务…") }
        catch { process = nil; throw CompanionFailure.message("无法启动内置运行时，请重新安装完整的 RecDock 助手。") }
    }

    func stop() {
        guard let child = process, child.isRunning else { return }
        child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { if child.isRunning { kill(child.processIdentifier, SIGKILL) } }
    }

    func request(_ path: String, value: [String: Any]? = nil, completion: @escaping (Result<Data, Error>) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:43127/desktop/" + path)!)
        request.setValue(control, forHTTPHeaderField: "X-RecDock-Control")
        if let value = value {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: value)
        }
        session.dataTask(with: request) { data, response, error in
            let result: Result<Data, Error>
            if let error = error { result = .failure(error) }
            else if let status = (response as? HTTPURLResponse)?.statusCode, status == 200 { result = .success(data ?? Data()) }
            else { result = .failure(CompanionFailure.message("本机管理请求未完成，请重试。")) }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    func readStatus(_ completion: @escaping (Result<DesktopStatus, Error>) -> Void) {
        request("status") { result in completion(result.flatMap { data in Result { try JSONDecoder().decode(DesktopStatus.self, from: data) } }) }
    }

    func runPython(_ arguments: [String], token: String? = nil, progress: @escaping (String) -> Void, completion: @escaping (Int32, Data) -> Void) throws {
        guard !isPreparing else { throw CompanionFailure.message("已有环境准备任务正在运行。") }
        let child = Process(), output = Pipe(), errors = Pipe()
        child.executableURL = python; child.arguments = ["-m", "recdock_audio.desktop"] + arguments; child.currentDirectoryURL = workspace
        var env = environment(); env.removeValue(forKey: "RECDOCK_CONTROL_TOKEN")
        if let token = token, !token.isEmpty { env["HF_TOKEN"] = token }
        child.environment = env; child.standardInput = FileHandle.nullDevice; child.standardOutput = output; child.standardError = errors
        taskOutput = Data()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.taskOutput.count < 2 * 1024 * 1024 { self.taskOutput.append(data) }
                // Display only known model state fields; never display SDK URLs or credentials.
                for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
                    if let bytes = String(line).data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let phase = value["phase"] as? String {
                        let names = ["asr": "转写模型", "aligner": "时间对齐模型", "diarizer": "讲话人模型"]
                        let phases = ["checking": "检查中", "downloading": "下载中", "verifying": "校验中", "retrying": "重试中", "ready": "已就绪", "failed": "未完成"]
                        progress((value["model"] as? String).flatMap { names[$0] } .map { $0 + " · " } .map { $0 + (phases[phase] ?? "处理中") } ?? "正在准备模型…")
                    }
                }
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        child.terminationHandler = { [weak self] child in
            let remaining = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.taskOutput.append(remaining)
                output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
                self.task = nil; self.taskPipes = []
                completion(child.terminationStatus, self.taskOutput)
            }
        }
        task = child; taskPipes = [output, errors]
        do { try child.run() } catch { task = nil; taskPipes = []; throw CompanionFailure.message("无法启动内置 Python 处理环境。") }
    }

    func cancelPreparation() { task?.terminate() }
}
