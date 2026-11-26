import '../../l10n/app_localizations.dart';
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
                      Text(context.tr('PLAUD 账号'),
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 12),
                      if (account == null) ...[
                        Text(auth.busy
                            ? context.tr('正在恢复登录…')
                            : context.tr('登录后连接账号已绑定的录音设备')),
                        const SizedBox(height: 10),
                        FilledButton(
                            onPressed: auth.busy ? null : login,
                            child: Text(context.tr('登录 PLAUD'))),
                      ] else
                        Card(
                            child: ListTile(
                                leading: const Icon(Icons.person_outline),
                                title: Text(account.email.isEmpty
                                    ? context.tr('已登录')
                                    : account.email),
                                subtitle: Text(
                                    context.tr('{0} 台绑定设备', [bound.length])),
                                trailing: PopupMenuButton<String>(
                                    tooltip: context.tr('账号操作'),
                                    onSelected: (value) => value == 'logout'
                                        ? logout()
                                        : refreshAccount(),
                                    itemBuilder: (_) => [
                                          PopupMenuItem(
                                              value: 'refresh',
                                              child:
                                                  Text(context.tr('刷新设备列表'))),
                                          PopupMenuItem(
                                              value: 'logout',
                                              child: Text(context.tr('退出登录')))
                                        ]))),
                      if (auth.error != null)
                        Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(context.message(auth.error!))),
                      const SizedBox(height: 24),
                    ]);
              }
              if (index == 1) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(context.tr('附近设备'),
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 8),
                      Text(context.tr('保持设备唤醒并靠近手机。如已连接官方 App，请先断开。')),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                          onPressed: connecting || device.busy ? null : scan,
                          icon: Icon(scanner.scanning
                              ? Icons.stop
                              : Icons.bluetooth_searching),
                          label: Text(scanner.scanning
                              ? context.tr('停止扫描')
                              : context.tr('扫描附近设备'))),
                      if (scanner.scanning) const LinearProgressIndicator(),
                      if (scanner.error != null)
                        Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(context.message(scanner.error!))),
                      if (account != null && bound.isEmpty && !auth.busy)
                        Padding(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            child: Text(context.tr('账号暂无绑定设备，请先在官方应用完成绑定'))),
                      if (account == null && scanner.devices.isNotEmpty) ...[
                        for (final nearby in scanner.devices)
                          ListTile(
                              leading: const Icon(Icons.mic_none),
                              title: Text(nearby.name.isEmpty
                                  ? nearby.advertisement.model
                                  : nearby.name),
                              subtitle: Text(context.tr('登录后可连接属于你的设备'))),
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
                            '${row.serialNumber}\n${active ? context.tr('已连接') : nearby == null ? context.tr('尚未在附近发现') : context.tr('已在附近发现')}'),
                        isThreeLine: true,
                        trailing: active
                            ? TextButton(
                                onPressed: disconnect,
                                child: Text(context.tr('断开')))
                            : FilledButton(
                                onPressed: nearby == null ||
                                        connecting ||
                                        auth.busy ||
                                        device.busy
                                    ? null
                                    : () => connect(row, nearby),
                                child: Text(context.tr('连接')))));
              }
              final after = index - 2 - bound.length;
              if (after == 0) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 20),
                      if (connecting || device.busy)
                        const LinearProgressIndicator(),
                      Text(context.message(device.stage)),
                      if (device.error != null)
                        Text(context.message(device.error!),
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      if (device.connected) ...[
                        const SizedBox(height: 12),
                        Wrap(spacing: 20, runSpacing: 8, children: [
                          Text(device.battery == null
                              ? context.tr('电量：未获取')
                              : context.tr('电量：{0}%{1}', [
                                  device.battery!.level,
                                  device.battery!.charging
                                      ? context.tr(' · 充电中')
                                      : ''
                                ])),
                          Text(device.storage == null
                              ? context.tr('存储：未获取')
                              : context.tr('可用 {0} / {1}', [
                                  storageSize(device.storage!.free),
                                  storageSize(device.storage!.total)
                                ])),
                        ]),
                        const SizedBox(height: 8),
                        Text(context.tr('录音状态：{0}', [
                              {
                                'unknown': context.tr('未获取'),
                                'idle': context.tr('空闲'),
                                'recording': context.tr('正在录音'),
                                'paused': context.tr('录音暂停'),
                                'transferring': context.tr('正在传输')
                              }[device.recording.mode]
                            ]) +
                            '${device.recording.durationAt(DateTime.now().millisecondsSinceEpoch) == null ? '' : context.tr(' · {0} 秒', [
                                    Duration(
                                            milliseconds: device.recording
                                                .durationAt(DateTime.now()
                                                    .millisecondsSinceEpoch)!)
                                        .inSeconds
                                  ])}'),
                        Wrap(spacing: 12, children: [
                          TextButton(
                              onPressed: device.busy ? null : refreshStatus,
                              child: Text(context.tr('刷新状态'))),
                          TextButton(
                              onPressed: device.busy ? null : refreshFiles,
                              child: Text(context.tr('刷新录音目录')))
                        ]),
                      ],
                      if (device.transferPhase == 'downloading' ||
                          device.transferPhase == 'cancelling') ...[
                        const SizedBox(height: 12),
                        LinearProgressIndicator(
                            value: device.total > 0
                                ? device.received / device.total
                                : null),
                        Text(context.tr(
                            '{0} / {1} 字节', [device.received, device.total])),
                        TextButton(
                            onPressed: device.cancelDownload,
                            child: Text(context.tr('暂停下载'))),
                      ],
                      if (device.transferNotice != null)
                        Text(context.message(device.transferNotice!)),
                      const SizedBox(height: 20),
                    ]);
              }
              if (after == 1) {
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                          context.tr('设备录音{0}',
                              [device.connected ? ' · ${rows.length}' : '']),
                          style: Theme.of(context).textTheme.titleLarge),
                      if (!device.connected)
                        Padding(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            child: Text(context.tr('连接设备后查看录音目录'))),
                      if (device.connected && rows.isEmpty)
                        Padding(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            child: Text(context.tr('暂无目录条目，可点击刷新录音目录'))),
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
                      '${storageSize(BigInt.from(file.size))} · ${local == null ? context.tr('设备上') : local.playable ? context.tr('已保存到本机') : context.tr('原件已保存')}'),
                  trailing: TextButton(
                      onPressed: device.busy || connecting
                          ? null
                          : () => download(file),
                      child: Text(local == null
                          ? context.tr('下载')
                          : local.playable
                              ? context.tr('播放')
                              : context.tr('恢复音频'))));
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
