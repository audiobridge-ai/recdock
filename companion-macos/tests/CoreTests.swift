import Foundation

@main struct CoreTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("recdock-native-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let resources = root.appendingPathComponent("resources"), support = root.appendingPathComponent("support")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let config = resources.appendingPathComponent("companion.json")
        try Data("{\"webOrigin\":\"https://recdock.example\"}".utf8).write(to: config)
        let runtime = try CompanionRuntime(resources: resources, support: support)
        precondition(runtime.models.path == support.appendingPathComponent("models").path)
        let selected = root.appendingPathComponent("existing-models")
        try runtime.selectModels(selected)
        let restored = try CompanionRuntime(resources: resources, support: support)
        precondition(restored.models.path == selected.path)
        let env = restored.environment()
        precondition(env["RECDOCK_LIBRARY_DIR"] == support.appendingPathComponent("library").path)
        precondition(env["RECDOCK_WEB_ORIGINS"] == "https://recdock.example")
        precondition(env["RECDOCK_CONTROL_TOKEN"]?.count == 43)
        precondition(env["RECDOCK_CONTROL_TOKEN"] != runtime.environment()["RECDOCK_CONTROL_TOKEN"])
        precondition(!env["PATH"]!.contains("homebrew"))
        precondition(env["RECDOCK_AUDIO_PYTHON"]!.hasPrefix(resources.path))
        precondition(env["RECDOCK_FILELOCK_HELPER"]!.hasPrefix(resources.path))
        for invalid in ["http://recdock.example", "https://user@recdock.example", "https://recdock.example/path", "https://recdock.example?secret=x"] {
            try JSONSerialization.data(withJSONObject: ["webOrigin":invalid]).write(to: config)
            do { _ = try CompanionRuntime(resources: resources, support: support); fatalError("Unsafe origin accepted") } catch {}
        }
        print("Native settings restoration, private data paths, independent control credentials and origin constraints passed")
    }
}
