import Foundation
import Darwin

// This helper only owns a kernel file lock. It has no credential or key API.
private enum HelperFailure: Error { case unavailable }

private func holdLock(path: String) throws {
    guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw HelperFailure.unavailable }
    let descriptor = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw HelperFailure.unavailable }
    defer { _ = flock(descriptor, LOCK_UN); _ = close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
        throw HelperFailure.unavailable
    }
    if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
        if errno == EWOULDBLOCK { exit(75) }
        throw HelperFailure.unavailable
    }
    try FileHandle.standardOutput.write(contentsOf: Data([1]))
    // Process death or parent pipe closure releases the lock without stale files.
    while !FileHandle.standardInput.readData(ofLength: 1).isEmpty {}
}

do {
    guard let line = readLine(), line.utf8.count <= 8192,
          let input = line.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          request["action"] as? String == "lock", let path = request["path"] as? String else {
        throw HelperFailure.unavailable
    }
    try holdLock(path: path)
} catch {
    try? FileHandle.standardError.write(contentsOf: Data("File lock helper unavailable\n".utf8))
    exit(1)
}
