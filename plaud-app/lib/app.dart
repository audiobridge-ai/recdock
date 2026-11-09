import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'features/devices/device_scanner.dart';
import 'features/devices/device_panel.dart';
import 'features/devices/ble_link.dart';
import 'features/auth/auth_controller.dart';
import 'features/auth/login_page.dart';
import 'features/auth/models.dart';
import 'core/device/device_controller.dart';
import 'core/device/packet_io.dart';
import 'core/protocol/files.dart';
import 'core/audio/device_audio.dart';
import 'core/failure.dart';
import 'features/library/recording_store.dart';
import 'features/transcription/assembly_client.dart';
import 'features/transcription/settings.dart';
import 'features/transcription/settings_page.dart';
import 'features/transcription/transcription_controller.dart';
import 'features/transcription/transcription_panel.dart';
import 'features/transcription/models.dart';
import 'features/transcription/task_center.dart';
import 'features/transcription/background/native_queue.dart';

class RecDockApp extends StatelessWidget {
  const RecDockApp(
      {super.key,
      this.store,
      this.auth,
      this.device,
      this.scanner,
      this.linkFactory,
      this.assemblyClient});
  final RecordingStore? store;
  final AuthController? auth;
  final DeviceController? device;
  final DeviceScanner? scanner;
  final Future<DeviceLink> Function(NearbyDevice)? linkFactory;
  final AssemblyClient? assemblyClient;

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'RecDock',
        theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(
                seedColor: Colors.black,
                primary: Colors.black,
                surface: Colors.white),
            scaffoldBackgroundColor: const Color(0xfffafafa),
            appBarTheme: const AppBarTheme(
                backgroundColor: Color(0xfffafafa),
                surfaceTintColor: Colors.transparent),
            filledButtonTheme: FilledButtonThemeData(
                style: FilledButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white)),
            inputDecorationTheme:
                const InputDecorationTheme(border: OutlineInputBorder())),
        home: Workspace(
            store: store,
            auth: auth,
            device: device,
            scanner: scanner,
            linkFactory: linkFactory,
            assemblyClient: assemblyClient),
      );
}

class Workspace extends StatefulWidget {
  const Workspace(
      {super.key,
      this.store,
      this.auth,
      this.device,
      this.scanner,
      this.linkFactory,
      this.assemblyClient});
  final RecordingStore? store;
  final AuthController? auth;
  final DeviceController? device;
  final DeviceScanner? scanner;
  final Future<DeviceLink> Function(NearbyDevice)? linkFactory;
  final AssemblyClient? assemblyClient;
  @override
  State<Workspace> createState() => _WorkspaceState();
}

class _WorkspaceState extends State<Workspace> with WidgetsBindingObserver {
  RecordingStore? _store;
  TranscriptionController? _transcription;
  late final DeviceScanner _scanner;
  late final AuthController _auth;
  late final DeviceController _device;
  bool _connecting = false;
  bool _deviceAction = false;
  String? _visibleAccount;
  Timer? _clock;
  final _search = TextEditingController();
  LibrarySnapshot? _snapshot;
  String? _loadError;
  bool _busy = false, _trash = false;
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    _scanner = widget.scanner ?? DeviceScanner();
    _auth = widget.auth ?? AuthController();
    _device = widget.device ?? DeviceController();
    _auth.addListener(_accountChanged);
    _device.onChanged = () {
      if (mounted) setState(() {});
    };
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _device.recording.mode == 'recording') setState(() {});
    });
    WidgetsBinding.instance.addObserver(this);
    unawaited(_initialize());
    unawaited(_auth.restore());
  }

  Future<void> _initialize() async {
    try {
      _store = widget.store ??
          RecordingStore(Directory(p.join(
              (await getApplicationSupportDirectory()).path, 'library-v1')));
      _store!.activeAccountId = _auth.session?.accountId;
      _transcription?.dispose();
      _transcription?.settings.dispose();
      _transcription = TranscriptionController(
          library: _store!,
          settings: AssemblySettings(secrets: _auth.secrets),
          client: widget.assemblyClient,
          nativeQueue: widget.assemblyClient == null
              ? const NativeTranscriptionQueue()
              : null);
      _transcription!.addListener(_transcriptionChanged);
      unawaited(_transcription!
          .activate(_auth.session?.accountId)
          .catchError((Object _) {}));
      await _reload();
    } catch (_) {
      if (mounted) setState(() => _loadError = '录音库暂时无法读取，请重试');
    }
  }

  Future<void> _reload() async {
    final account = _auth.session?.accountId;
    final snapshot = await _store!.load();
    if (mounted &&
        account == _auth.session?.accountId &&
        account == _store!.activeAccountId) {
      setState(() {
        _snapshot = snapshot;
        _loadError = null;
      });
      unawaited(_transcription?.reload().catchError((Object _) {}));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _transcription?.setForeground(state == AppLifecycleState.resumed);
    _device.setForeground(state == AppLifecycleState.resumed);
    if (state != AppLifecycleState.resumed) {
      unawaited(_scanner.stop());
      _device.cancelDownload();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scanner.dispose();
    _clock?.cancel();
    _auth.removeListener(_accountChanged);
    _auth.dispose();
    _transcription?.dispose();
    _transcription?.settings.dispose();
    unawaited(_device.dispose());
    _search.dispose();
    super.dispose();
  }

  void _transcriptionChanged() {
    if (mounted) setState(() {});
  }

  void _accountChanged() {
    if (!mounted) return;
    final account = _auth.session?.accountId;
    if (account != _visibleAccount) {
      final previous = _visibleAccount;
      _visibleAccount = account;
      if (_store != null) _store!.activeAccountId = account;
      unawaited(_transcription?.activate(account).catchError((Object _) {}));
      _snapshot = null;
      unawaited(_device.disconnect());
      if (previous != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
        });
      }
      if (_store != null) unawaited(_reload().catchError((Object _) {}));
    }
    setState(() {});
  }

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      _notice(e is AppFailure ? e.message : '操作未完成，请稍后重试');
    }
  }

  Future<void> _login() async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => LoginPage(auth: _auth)));
  }

  Future<void> _connect(BoundDevice bound, NearbyDevice nearby) async {
    if (_connecting || _device.busy || _auth.busy) return;
    setState(() => _connecting = true);
    DeviceLink? link;
    var attached = false;
    try {
      final owner = _auth.session?.accountId;
      await _scanner.stop();
      final port = nearby.advertisement.portVersion ?? bound.portVersion;
      if (port == null) {
        throw const AppFailure('PORT_VERSION_REQUIRED', '未取得此设备的协议版本，请重新扫描');
      }
      _device.stage = '正在准备设备认证材料';
      if (mounted) setState(() {});
      final credentials = await _auth.prepare(bound.serialNumber, port);
      if (!mounted || _auth.session?.accountId != owner) {
        throw const AppFailure('SESSION_CHANGED', '设备账号已经改变');
      }
      _device.stage = '正在连接蓝牙';
      setState(() {});
      link = widget.linkFactory != null
          ? await widget.linkFactory!(nearby)
          : await ReactiveDeviceLink.open(_scanner.ble, nearby.id);
      if (!mounted || _auth.session?.accountId != owner) {
        throw const AppFailure('SESSION_CHANGED', '设备账号已经改变');
      }
      attached = true;
      await _device.connect(link, credentials);
      if (_device.recording.mode == 'idle') await _device.listFiles();
    } catch (e) {
      if (!attached) await link?.close();
      _device.stage = e is AppFailure ? e.message : '设备连接未完成，请重试';
      _notice(_device.stage);
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _download(RecordingFile file) async {
    if (_deviceAction || !mounted) return;
    setState(() => _deviceAction = true);
    try {
      await _downloadFile(file);
    } finally {
      if (mounted) setState(() => _deviceAction = false);
    }
  }

  Future<void> _downloadFile(RecordingFile file) async {
    final store = _store, credentials = _device.credentials;
    if (store == null ||
        credentials == null ||
        !_device.connected ||
        _device.busy ||
        _busy) {
      return;
    }
    final owner = credentials.accountId, serial = credentials.serialNumber;
    final existing =
        await store.findDevice(owner, serial, file.sessionId, file.size);
    if (existing != null && existing.playable) {
      await _select(existing);
      return;
    }
    final free = await const MethodChannel('ai.audiobridge.recdock/platform')
        .invokeMethod<int>('freeDiskBytes');
    if (free == null || free < file.size * 5 + 32 * 1024 * 1024) {
      throw const AppFailure('DISK_FULL', '本机可用空间不足，请清理空间后下载');
    }
    final target = store.transferFile(owner, serial, file.sessionId, file.size);
    File original;
    if (existing != null) {
      original = store.originalFile(existing);
    } else {
      original = await _device.download(file, target);
    }
    if (_auth.session?.accountId != owner) {
      throw const AppFailure('SESSION_CHANGED', '设备账号已经改变，原件已保留');
    }
    if (!mounted) return;
    setState(() => _busy = true);
    final playable = File('${target.path}.ogg');
    try {
      final result = await recoverDeviceAudio(original,
          output: playable,
          rsa: credentials.rsa,
          channels: _device.audioChannels,
          isOggAudio: _device.isOggAudio);
      if (_auth.session?.accountId != owner) {
        throw const AppFailure('SESSION_CHANGED', '设备账号已经改变，原件已保留');
      }
      final saved = await store.saveDevice(
          owner: owner,
          serial: serial,
          session: file.sessionId,
          original: original,
          playable: result.playable,
          notice: result.notice);
      await _reload();
      if (_device.connected) _device.stage = '设备已连接';
      if (existing == null && await target.exists()) await target.delete();
      if (mounted) {
        if (saved.playable) {
          await _select(saved);
        } else {
          _notice(saved.notice ?? '原件已保存，暂时无法播放');
        }
      }
    } finally {
      if (await playable.exists()) await playable.delete();
      if (mounted) setState(() => _busy = false);
    }
  }

  void _notice(String message) {
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    }
  }

  Future<void> _import() async {
    if (_busy || _store == null) return;
    setState(() => _busy = true);
    try {
      final picked = await FilePicker.platform.pickFiles(
          type: FileType.custom,
          allowedExtensions: [
            'wav',
            'mp3',
            'm4a',
            'aac',
            'ogg',
            'flac',
            'opus',
            'mp4'
          ]);
      if (!mounted || picked == null) return;
      final path = picked.files.single.path;
      if (path == null) throw const FormatException('无法读取所选文件，请重新选择');
      await _store!.importFile(File(path),
          title: p.basenameWithoutExtension(picked.files.single.name));
      await _reload();
      if (mounted) setState(() => _trash = false);
      _notice('音频已保存到本机');
    } catch (e) {
      _notice(e is FormatException ? e.message : '导入未完成，请检查文件和手机可用空间后重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _select(LocalRecording recording) async {
    if (recording.accountId != null &&
        recording.accountId != _auth.session?.accountId) {
      _notice('请登录此录音所属账号');
      return;
    }
    if (_trash) {
      try {
        await _store!.setDeleted(recording.id, false);
        await _reload();
      } catch (_) {
        _notice('恢复未完成，请重试');
      }
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => RecordingDetail(
            recording: recording,
            store: _store!,
            transcription: _transcription)));
    if (mounted) {
      try {
        await _reload();
      } catch (_) {
        _notice('录音列表刷新失败，请重试');
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
            title: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.graphic_eq, size: 26),
              const SizedBox(width: 10),
              Flexible(
                  child: Text(
                      _tab == 0
                          ? (_trash ? '回收站' : 'RecDock')
                          : _tab == 1
                              ? '设备'
                              : '设置',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis)),
            ]),
            actions: [
              if (_transcription != null && _store != null)
                IconButton(
                    tooltip: '转写任务',
                    onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                            builder: (_) => TranscriptionTaskCenter(
                                controller: _transcription!,
                                library: _store!,
                                onOpen: _select))),
                    icon: Badge(
                        isLabelVisible: _transcription!.activeTaskCount > 0,
                        label: Text('${_transcription!.activeTaskCount}'),
                        child: const Icon(Icons.playlist_add_check))),
              if (_tab == 0)
                IconButton(
                    tooltip: _trash ? '返回录音' : '回收站',
                    onPressed: () => setState(() => _trash = !_trash),
                    icon: Icon(_trash
                        ? Icons.library_music_outlined
                        : Icons.delete_outline))
            ]),
        body: SafeArea(
            child: _tab == 0
                ? _library()
                : _tab == 1
                    ? _devices()
                    : _settings()),
        floatingActionButton: _tab == 0 && !_trash
            ? FloatingActionButton.extended(
                backgroundColor: Colors.black,
                foregroundColor: Colors.white,
                onPressed: _busy || _store == null ? null : _import,
                icon: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.add),
                label: Text(_busy ? '正在导入' : '导入音频'))
            : null,
        bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (tab) {
              if (tab != 1) unawaited(_scanner.stop());
              setState(() => _tab = tab);
            },
            destinations: const [
              NavigationDestination(
                  icon: Icon(Icons.library_music_outlined), label: '录音'),
              NavigationDestination(icon: Icon(Icons.bluetooth), label: '设备'),
              NavigationDestination(icon: Icon(Icons.tune), label: '设置'),
            ]),
      );

  Widget _library() {
    if (_loadError != null) {
      return _empty(Icons.folder_off_outlined, _loadError!,
          action: TextButton(onPressed: _initialize, child: const Text('重试')));
    }
    if (_snapshot == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final rows = _snapshot!.recordings
        .where((recording) =>
            recording.deleted == _trash &&
            recording.title.toLowerCase().contains(_search.text.toLowerCase()))
        .toList();
    return Column(children: [
      Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
          child: TextField(
              controller: _search,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                  hintText: '搜索录音',
                  prefixIcon: Icon(Icons.search),
                  isDense: true))),
      if (_snapshot!.unreadableCount > 0)
        Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Text('有 ${_snapshot!.unreadableCount} 条录音暂时无法读取，文件已保留')),
      Expanded(
          child: rows.isEmpty
              ? _empty(
                  _trash ? Icons.delete_outline : Icons.graphic_eq,
                  _search.text.isNotEmpty
                      ? '没有匹配的录音'
                      : _trash
                          ? '回收站是空的'
                          : '把录音放在一起',
                  subtitle: _trash ? '移入回收站的录音可以恢复' : '导入手机中的音频，随时播放和整理')
              : RefreshIndicator(
                  onRefresh: _reload,
                  child: ListView.separated(
                      padding: const EdgeInsets.only(bottom: 100),
                      itemCount: rows.length,
                      separatorBuilder: (_, __) =>
                          const Divider(height: 1, indent: 76),
                      itemBuilder: (_, i) {
                        final recording = rows[i];
                        return ListTile(
                            contentPadding: const EdgeInsets.symmetric(
                                horizontal: 20, vertical: 8),
                            leading: Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                    color: const Color(0xffefefef),
                                    borderRadius: BorderRadius.circular(12)),
                                child: const Icon(Icons.audio_file_outlined)),
                            title: Text(recording.title,
                                maxLines: 2, overflow: TextOverflow.ellipsis),
                            subtitle: Text(
                                '${_date(recording.createdAt)} · ${_size(recording.bytes)}${_transcription?.snapshots[recording.id]?.latest == null ? '' : '\n${jobLabel(_transcription!.snapshots[recording.id]!.latest!.state)}'}'),
                            trailing: Icon(
                                _trash ? Icons.restore : Icons.chevron_right),
                            onTap: () => unawaited(_select(recording)));
                      }))),
    ]);
  }

  Widget _devices() => DevicePanel(
      auth: _auth,
      scanner: _scanner,
      device: _device,
      connecting: _connecting || _busy || _deviceAction,
      login: () => unawaited(_login()),
      logout: () => unawaited(_guard(() async {
            await _device.disconnect();
            await _auth.logout();
          })),
      refreshAccount: () => unawaited(_guard(_auth.refreshDevices)),
      scan: () =>
          unawaited(_scanner.scanning ? _scanner.stop() : _scanner.start()),
      connect: (bound, nearby) => unawaited(_connect(bound, nearby)),
      disconnect: () => unawaited(_guard(() => _device.disconnect())),
      refreshStatus: () => unawaited(_guard(_device.refreshStatus)),
      refreshFiles: () => unawaited(_guard(_device.listFiles)),
      download: (file) => unawaited(_guard(() => _download(file))),
      saved: _snapshot?.recordings ?? const []);

  Widget _settings() => ListView(padding: const EdgeInsets.all(20), children: [
        Text('你的录音，保存在本机', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        const Text(
            '导入音频不需要 PLAUD 账号。原文件保存在 App 专属目录，移入回收站后可以恢复。卸载 App 会清除本机资料。'),
        const SizedBox(height: 24),
        ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.transcribe),
            title: const Text('AssemblyAI 转写设置'),
            subtitle: Text(_transcription?.settings.config == null
                ? '配置自己的 API Key，主动上传后转写'
                : '已配置 · ${_transcription!.settings.config!.region.toUpperCase()}'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _transcription == null || _transcription!.settings.loading
                ? null
                : () => unawaited(Navigator.of(context).push(
                    MaterialPageRoute<void>(
                        builder: (_) => AssemblySettingsPage(
                            settings: _transcription!.settings))))),
        const SizedBox(height: 16),
        const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.info_outline),
            title: Text('RecDock'),
            subtitle: Text('0.3.0 · Android / iOS')),
        const Text('RecDock 是独立客户端，与 PLAUD 官方无关联。'),
      ]);
}

Widget _empty(IconData icon, String title,
        {String? subtitle, Widget? action}) =>
    Center(
        child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 48, color: Colors.black54),
              const SizedBox(height: 18),
              Text(title,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                      fontSize: 21, fontWeight: FontWeight.w600)),
              if (subtitle != null) ...[
                const SizedBox(height: 10),
                Text(subtitle, textAlign: TextAlign.center)
              ],
              if (action != null) action,
            ])));

String _size(int bytes) => bytes < 1024 * 1024
    ? '${(bytes / 1024).toStringAsFixed(1)} KiB'
    : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MiB';
String _date(DateTime date) {
  final local = date.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
}

class RecordingDetail extends StatefulWidget {
  const RecordingDetail(
      {super.key,
      required this.recording,
      required this.store,
      this.transcription});
  final LocalRecording recording;
  final RecordingStore store;
  final TranscriptionController? transcription;
  @override
  State<RecordingDetail> createState() => _RecordingDetailState();
}

class _RecordingDetailState extends State<RecordingDetail>
    with WidgetsBindingObserver {
  final _player = AudioPlayer();
  late LocalRecording _recording;
  String? _error;
  bool _ready = false;
  @override
  void initState() {
    super.initState();
    _recording = widget.recording;
    WidgetsBinding.instance.addObserver(this);
    unawaited(_prepare());
  }

  Future<void> _prepare() async {
    try {
      if (!_recording.playable) {
        if (mounted) {
          setState(() => _error = _recording.notice ?? '原件已保存，暂时无法播放');
        }
        return;
      }
      final file = await iosPlayableFile(widget.store.audioFile(_recording));
      await _player.setFilePath(file.path);
      if (mounted) setState(() => _ready = true);
    } catch (_) {
      if (mounted) setState(() => _error = '当前设备无法播放此音频格式，原文件已保留');
    }
  }

  Future<void> _seekTranscript(int milliseconds) async {
    if (!_ready) return;
    await _player.seek(Duration(
        milliseconds: milliseconds.clamp(
            0, _player.duration?.inMilliseconds ?? milliseconds)));
    unawaited(_player.play().catchError((Object _) {
      if (mounted) setState(() => _error = '播放中断，请重新打开录音');
    }));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(_player.pause());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_player.dispose());
    super.dispose();
  }

  Future<void> _rename() async {
    var draft = _recording.title;
    final title = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('修改标题'),
                content: TextFormField(
                    initialValue: draft,
                    onChanged: (value) => draft = value,
                    maxLength: 200,
                    autofocus: true),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('取消')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, draft),
                      child: const Text('保存'))
                ]));
    if (title == null || !mounted) return;
    try {
      final updated = await widget.store.rename(_recording.id, title);
      if (mounted) setState(() => _recording = updated);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('标题保存失败，请填写 1–200 个字符后重试')));
      }
    }
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('移入回收站？'),
                content: const Text('原音频仍会保留，可以从回收站恢复。'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('取消')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('移入回收站'))
                ]));
    if (confirmed != true || !mounted) return;
    try {
      await _player.pause();
      try {
        await widget.transcription?.cancelPending(_recording);
      } catch (_) {/* A submitted cloud task continues. */}
      await widget.store.setDeleted(_recording.id, true);
      if (mounted) Navigator.pop(context);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('操作未完成，请重试')));
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('录音详情'), actions: [
          IconButton(
              tooltip: '修改标题',
              onPressed: _rename,
              icon: const Icon(Icons.edit_outlined)),
          IconButton(
              tooltip: '移入回收站',
              onPressed: _delete,
              icon: const Icon(Icons.delete_outline))
        ]),
        body: SafeArea(
            child: Padding(
                padding: const EdgeInsets.all(24),
                child: widget.transcription == null
                    ? SingleChildScrollView(child: _audioHeader())
                    : TranscriptionPanel(
                        recording: _recording,
                        controller: widget.transcription!,
                        durationMs: _player.duration?.inMilliseconds ?? 0,
                        canPlay: _ready,
                        onSeek: _seekTranscript,
                        audioHeader: _audioHeader()))),
      );

  Widget _audioHeader() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(_recording.title,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        Text('${_date(_recording.createdAt)} · ${_size(_recording.bytes)}'),
        if (_error != null) Text(_error!),
        if (_error == null && !_ready)
          const Center(child: CircularProgressIndicator()),
        if (_ready)
          StreamBuilder<Duration>(
              stream: _player.positionStream,
              builder: (context, snapshot) {
                final duration = _player.duration ?? Duration.zero;
                final position = snapshot.data ?? Duration.zero;
                return Column(children: [
                  Slider(
                      value: position.inMilliseconds
                          .clamp(0, duration.inMilliseconds)
                          .toDouble(),
                      max: duration.inMilliseconds > 0
                          ? duration.inMilliseconds.toDouble()
                          : 1,
                      onChanged: duration == Duration.zero
                          ? null
                          : (value) => unawaited(_player
                              .seek(Duration(milliseconds: value.toInt())))),
                  Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(_clock(position)),
                        Text(_clock(duration))
                      ]),
                ]);
              }),
        const SizedBox(height: 20),
        if (_ready)
          Center(
              child: StreamBuilder<PlayerState>(
                  stream: _player.playerStateStream,
                  builder: (context, snapshot) => IconButton.filled(
                      iconSize: 38,
                      onPressed: () async {
                        try {
                          if (_player.playing) {
                            await _player.pause();
                          } else {
                            if (_player.processingState ==
                                ProcessingState.completed) {
                              await _player.seek(Duration.zero);
                            }
                            unawaited(_player.play().catchError((Object _) {
                              if (mounted) {
                                setState(() => _error = '播放中断，请重新打开录音');
                              }
                            }));
                          }
                        } catch (_) {
                          if (mounted) {
                            setState(() => _error = '播放中断，请重新打开录音');
                          }
                        }
                      },
                      icon: Icon(snapshot.data?.playing == true
                          ? Icons.pause
                          : Icons.play_arrow)))),
        const SizedBox(height: 20),
      ]);
}

String _clock(Duration value) =>
    '${value.inMinutes.toString().padLeft(2, '0')}:'
    '${(value.inSeconds % 60).toString().padLeft(2, '0')}';
