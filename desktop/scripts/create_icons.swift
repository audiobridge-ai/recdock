import AppKit

// Original vector artwork; no external font or image assets.
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
func image(_ size: Int, tray: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 1024
    let transform = NSAffineTransform()
    transform.scaleX(by: scale, yBy: scale)
    transform.concat()
    if !tray {
        NSColor(calibratedRed: 0.055, green: 0.13, blue: 0.19, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 218, yRadius: 218).fill()
    }
    let heights: [CGFloat] = [176, 300, 452, 300, 176]
    for (i, height) in heights.enumerated() {
        (tray ? NSColor.black : i == 2 ? NSColor(calibratedRed: 0.32, green: 0.91, blue: 0.76, alpha: 1) : NSColor.white).setFill()
        let x = CGFloat(232 + i * 118)
        NSBezierPath(roundedRect: NSRect(x: x, y: 548 - height / 2, width: 88, height: height), xRadius: 44, yRadius: 44).fill()
    }
    (tray ? NSColor.black : NSColor(calibratedRed: 0.32, green: 0.91, blue: 0.76, alpha: 1)).setFill()
    NSBezierPath(roundedRect: NSRect(x: 232, y: 224, width: 560, height: 66), xRadius: 33, yRadius: 33).fill()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
let iconset = output.appendingPathComponent("RecDock.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try image(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try image(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
try image(1024).write(to: output.appendingPathComponent("RecDock.png"))
try image(18, tray: true).write(to: output.appendingPathComponent("Tray.png"))
try image(36, tray: true).write(to: output.appendingPathComponent("Tray@2x.png"))
