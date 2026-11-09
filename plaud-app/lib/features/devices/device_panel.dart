import 'package:flutter/material.dart';
import '../../core/device/device_controller.dart';
import '../../core/protocol/files.dart';
import '../auth/auth_controller.dart';
import '../auth/models.dart';
import '../library/recording_store.dart';
import 'device_scanner.dart';

class DevicePanel extends StatelessWidget {
  const DevicePanel(
      {super.key,
      required this.auth,
      required this.scanner,
      required this.device,
      required this.connecting,
      required this.login,
      required this.logout,
      required this.refreshAccount,
      required this.scan,
      required this.connect,
      required this.disconnect,
      required this.refreshStatus,
      required this.refreshFiles,
      required this.download,
      required this.saved});
  final AuthController auth;
  final DeviceScanner scanner;
  final DeviceController device;
  final bool connecting;
  final VoidCallback login,
      logout,
      refreshAccount,
      scan,
      disconnect,
      refreshStatus,
      refreshFiles;
  final void Function(BoundDevice, NearbyDevice) connect;
  final void Function(RecordingFile) download;
  final List<LocalRecording> saved;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: scanner,
      builder: (context, _) {
        final account = auth.session;
        final bound = account?.devices ?? <BoundDevice>[];
        final rows = device.connected ? device.files : <RecordingFile>[];
        return ListView.builder(
            padding: const EdgeInsets.all(20),
            itemCount: 5 + bound.length + rows.length,
            itemBuilder: (context, index) {
              if (index == 0) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('PLAUD 账号',
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 12),
                      if (account == null) ...[
                        Text(auth.busy ? '正在恢复登录…' : '登录后连接账号已绑定的录音设备'),
                        const SizedBox(height: 10),
                        FilledButton(
                            onPressed: auth.busy ? null : login,
                            child: const Text('登录 PLAUD')),
                      ] else
                        Card(
                            child: ListTile(
                                leading: const Icon(Icons.person_outline),
                                title: Text(account.email.isEmpty
                                    ? '已登录'
                                    : account.email),
                                subtitle: Text('${bound.length} 台绑定设备'),
                                trailing: PopupMenuButton<String>(
                                    tooltip: '账号操作',
                                    onSelected: (value) => value == 'logout'
                                        ? logout()
                                        : refreshAccount(),
                                    itemBuilder: (_) => [
                                          const PopupMenuItem(
                                              value: 'refresh',
                                              child: Text('刷新设备列表')),
                                          const PopupMenuItem(
                                              value: 'logout',
                                              child: Text('退出登录'))
                                        ]))),
                      if (auth.error != null)
                        Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(auth.error!)),
                      const SizedBox(height: 24),
                    ]);
              }
              if (index == 1) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('附近设备',
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 8),
                      const Text('保持设备唤醒并靠近手机。如已连接官方 App，请先断开。'),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                          onPressed: connecting || device.busy ? null : scan,
                          icon: Icon(scanner.scanning
                              ? Icons.stop
                              : Icons.bluetooth_searching),
                          label: Text(scanner.scanning ? '停止扫描' : '扫描附近设备')),
                      if (scanner.scanning) const LinearProgressIndicator(),
                      if (scanner.error != null)
                        Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(scanner.error!)),
                      if (account != null && bound.isEmpty && !auth.busy)
                        const Padding(
                            padding: EdgeInsets.symmetric(vertical: 12),
                            child: Text('账号暂无绑定设备，请先在官方应用完成绑定')),
                      if (account == null && scanner.devices.isNotEmpty) ...[
                        for (final nearby in scanner.devices)
                          ListTile(
                              leading: const Icon(Icons.mic_none),
                              title: Text(nearby.name.isEmpty
                                  ? nearby.advertisement.model
                                  : nearby.name),
                              subtitle: const Text('登录后可连接属于你的设备')),
                      ],
                    ]);
              }
              final boundIndex = index - 2;
              if (boundIndex >= 0 && boundIndex < bound.length) {
                final row = bound[boundIndex];
                final matches = scanner.devices.where(
                    (d) => d.advertisement.serialNumber == row.serialNumber);
                final nearby = matches.isEmpty ? null : matches.first;
                final active = device.connected &&
                    device.credentials?.serialNumber == row.serialNumber;
                return Card(
                    child: ListTile(
                        leading: Icon(active
                            ? Icons.bluetooth_connected
                            : Icons.mic_none),
                        title: Text(row.name),
                        subtitle: Text(
                            '${row.serialNumber}\n${active ? '已连接' : nearby == null ? '尚未在附近发现' : '已在附近发现'}'),
                        isThreeLine: true,
                        trailing: active
                            ? TextButton(
                                onPressed: disconnect, child: const Text('断开'))
                            : FilledButton(
                                onPressed: nearby == null ||
                                        connecting ||
                                        auth.busy ||
                                        device.busy
                                    ? null
                                    : () => connect(row, nearby),
                                child: const Text('连接'))));
              }
              final after = index - 2 - bound.length;
              if (after == 0) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 20),
                      if (connecting || device.busy)
                        const LinearProgressIndicator(),
                      Text(device.stage),
                      if (device.error != null)
                        Text(device.error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      if (device.connected) ...[
                        const SizedBox(height: 12),
                        Wrap(spacing: 20, runSpacing: 8, children: [
                          Text(device.battery == null
                              ? '电量：未获取'
                              : '电量：${device.battery!.level}%${device.battery!.charging ? ' · 充电中' : ''}'),
                          Text(device.storage == null
                              ? '存储：未获取'
                              : '可用 ${storageSize(device.storage!.free)} / ${storageSize(device.storage!.total)}'),
                        ]),
                        const SizedBox(height: 8),
                        Text('录音状态：${{
                          'unknown': '未获取',
                          'idle': '空闲',
                          'recording': '正在录音',
                          'paused': '录音暂停',
                          'transferring': '正在传输'
                        }[device.recording.mode]}'
                            '${device.recording.durationAt(DateTime.now().millisecondsSinceEpoch) == null ? '' : ' · ${Duration(milliseconds: device.recording.durationAt(DateTime.now().millisecondsSinceEpoch)!).inSeconds} 秒'}'),
                        Wrap(spacing: 12, children: [
                          TextButton(
                              onPressed: device.busy ? null : refreshStatus,
                              child: const Text('刷新状态')),
                          TextButton(
                              onPressed: device.busy ? null : refreshFiles,
                              child: const Text('刷新录音目录'))
                        ]),
                      ],
                      if (device.transferPhase == 'downloading' ||
                          device.transferPhase == 'cancelling') ...[
                        const SizedBox(height: 12),
                        LinearProgressIndicator(
                            value: device.total > 0
                                ? device.received / device.total
                                : null),
                        Text('${device.received} / ${device.total} 字节'),
                        TextButton(
                            onPressed: device.cancelDownload,
                            child: const Text('暂停下载')),
                      ],
                      if (device.transferNotice != null)
                        Text(device.transferNotice!),
                      const SizedBox(height: 20),
                    ]);
              }
              if (after == 1) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('设备录音${device.connected ? ' · ${rows.length}' : ''}',
                          style: Theme.of(context).textTheme.titleLarge),
                      if (!device.connected)
                        const Padding(
                            padding: EdgeInsets.symmetric(vertical: 16),
                            child: Text('连接设备后查看录音目录')),
                      if (device.connected && rows.isEmpty)
                        const Padding(
                            padding: EdgeInsets.symmetric(vertical: 16),
                            child: Text('暂无目录条目，可点击刷新录音目录')),
                    ]);
              }
              final fileIndex = after - 2;
              if (fileIndex < 0 || fileIndex >= rows.length) {
                return const SizedBox(height: 32);
              }
              final file = rows[fileIndex];
              final existing = saved.where((r) =>
                  !r.deleted &&
                  r.deviceSerial == device.credentials?.serialNumber &&
                  r.accountId == account?.accountId &&
                  r.sessionId == file.sessionId &&
                  r.bytes == file.size);
              final local = existing.isEmpty ? null : existing.first;
              return ListTile(
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                  leading: const Icon(Icons.audio_file_outlined),
                  title: Text(local?.title ?? deviceTitle(file.sessionId)),
                  subtitle: Text(
                      '${storageSize(BigInt.from(file.size))} · ${local == null ? '设备上' : local.playable ? '已保存到本机' : '原件已保存'}'),
                  trailing: TextButton(
                      onPressed: device.busy || connecting
                          ? null
                          : () => download(file),
                      child: Text(local == null
                          ? '下载'
                          : local.playable
                              ? '播放'
                              : '恢复音频')));
            });
      });
}

String storageSize(BigInt bytes) {
  if (bytes < BigInt.from(1024)) return '$bytes B';
  final units = ['KiB', 'MiB', 'GiB', 'TiB'];
  var unit = BigInt.from(1024), i = 0;
  while (i < units.length - 1 && bytes >= unit * BigInt.from(1024)) {
    unit *= BigInt.from(1024);
    i++;
  }
  return '${(bytes * BigInt.from(10) ~/ unit).toDouble() / 10} ${units[i]}';
}
