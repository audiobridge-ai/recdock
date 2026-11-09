import Foundation
import CoreBluetooth
import Darwin

// Only the requested account device's advertisement is returned on a private pipe.
// No GATT connection, file output, device name, MAC address, token, or key access.
private func emit(_ object: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: object) {
        try? FileHandle.standardOutput.write(contentsOf: bytes + Data([10]))
    }
}
private func serialNumber(_ bytes: [UInt8]) -> String? {
    guard bytes.count >= 6 else { return nil }
    var length = Int(bytes[0]), start = 1
    if length == 2 {
        guard bytes.count >= 5 else { return nil }
        length = Int(bytes[3]); start = 4
    }
    let countAt = start + length
    guard length >= 1, length <= 5, countAt < bytes.count else { return nil }
    let count = Int(bytes[countAt]), serialAt = countAt + 1
    guard count > 0, serialAt + count <= bytes.count else { return nil }
    let serial = Array(bytes[serialAt..<(serialAt + count)])
    if count < 10 { return serial.map { String(format: "%02X", $0) }.joined() }
    return String(bytes: serial.filter { $0 != 0 }, encoding: .utf8)
}
private final class Scanner: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager?
    private let target: String
    private var finished = false
    init(target: String) { self.target = target }
    func start() {
        manager = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) {
            if self.manager?.state != .poweredOn { self.finish("BLUETOOTH_PERMISSION_REQUIRED") }
        }
    }
    func finish(_ code: String) {
        guard !finished else { return }
        finished = true; manager?.stopScan()
        emit(["type": "error", "code": code]); exit(0)
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.finish("DEVICE_NOT_FOUND") }
        case .unauthorized: finish("BLUETOOTH_PERMISSION_REQUIRED")
        case .poweredOff: finish("BLUETOOTH_POWERED_OFF")
        case .unsupported: finish("BLUETOOTH_UNSUPPORTED")
        case .unknown, .resetting: break
        @unknown default: finish("BLUETOOTH_UNAVAILABLE")
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard !finished, let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
              data.count >= 8, data.count <= 512 else { return }
        let bytes = Array(data)
        guard serialNumber(Array(bytes.dropFirst(2))) == target else { return }
        emit(["type": "advertisement", "manufacturerHex": bytes.map { String(format: "%02x", $0) }.joined()])
    }
}
// This mode validates fixtures without creating CBCentralManager or accessing Bluetooth.
if CommandLine.arguments.dropFirst().first == "--decode-fixture" {
    if let line = readLine(), line.count <= 1024 {
        let parts = line.split(separator: " "), bytes = parts.compactMap { UInt8($0, radix: 16) }
        emit(["serialNumber": serialNumber(bytes) as Any? ?? NSNull()])
    }
    exit(0)
}
guard let line = readLine(), line.utf8.count <= 1024,
      let bytes = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let target = input["serialNumber"] as? String,
      target.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
    emit(["type": "error", "code": "DEVICE_REQUIRED"]); exit(1)
}
private let scanner = Scanner(target: target)
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { scanner.finish("OPERATION_CANCELLED") }; termination.resume()
scanner.start(); RunLoop.main.run()
