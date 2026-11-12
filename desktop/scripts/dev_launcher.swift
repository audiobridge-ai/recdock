import AppKit

final class DevelopmentLauncher: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let electron = Bundle.main.object(forInfoDictionaryKey: "RecDockElectron") as? String,
              let project = Bundle.main.object(forInfoDictionaryKey: "RecDockProject") as? String,
              let resources = Bundle.main.object(forInfoDictionaryKey: "RecDockResources") as? String else {
            NSApplication.shared.terminate(nil); return
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: electron).appendingPathComponent("Contents/MacOS/Electron")
        child.arguments = [project]
        var environment = ProcessInfo.processInfo.environment
        environment["RECDOCK_RESOURCES"] = resources
        child.environment = environment
        child.currentDirectoryURL = URL(fileURLWithPath: project)
        do { try child.run() }
        catch {
            let alert = NSAlert(); alert.messageText = "开发工作台未能启动"; alert.informativeText = error.localizedDescription; alert.runModal()
        }
        NSApplication.shared.terminate(nil)
    }
}
let application = NSApplication.shared
let delegate = DevelopmentLauncher()
application.delegate = delegate
application.run()
