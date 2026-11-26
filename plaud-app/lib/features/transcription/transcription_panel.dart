import '../../l10n/app_localizations.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/failure.dart';
import '../library/recording_store.dart';
import 'export_service.dart';
import 'models.dart';
import 'settings_page.dart';
import 'transcript_export.dart';
import 'transcription_controller.dart';

class TranscriptionPanel extends StatefulWidget {
  const TranscriptionPanel(
      {super.key,
      required this.recording,
      required this.controller,
      required this.durationMs,
      required this.onSeek,
      required this.canPlay,
      this.exportService,
      this.audioHeader});
  final LocalRecording recording;
  final TranscriptionController controller;
  final int durationMs;
  final bool canPlay;
  final Future<void> Function(int) onSeek;
  final TranscriptExportService? exportService;
  final Widget? audioHeader;
  @override
  State<TranscriptionPanel> createState() => _TranscriptionPanelState();
}

class _TranscriptionPanelState extends State<TranscriptionPanel> {
  TranscriptRevision? revision;
  String? selectedId, error;
  String query = '';
  bool loading = true, editing = false;
  int _loadEpoch = 0;
  String? _lastHead;
  TranscriptionController get controller => widget.controller;
  @override
  void initState() {
    super.initState();
    controller.addListener(_changed);
    unawaited(load());
  }

  @override
  void dispose() {
    ++_loadEpoch;
    controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    final head = controller.snapshots[widget.recording.id]?.current;
    if (head != _lastHead) {
      _lastHead = head;
      unawaited(load());
    }
    setState(() {});
  }

  Future<void> load() async {
    final epoch = ++_loadEpoch;
    try {
      final snapshot = await controller.store.load(widget.recording);
      final value =
          await controller.store.readRevision(widget.recording, selectedId);
      if (mounted && epoch == _loadEpoch) {
        setState(() {
          revision = value;
          loading = false;
          error = null;
          _lastHead = snapshot.current;
        });
      }
    } catch (e) {
      if (mounted && epoch == _loadEpoch) {
        setState(() {
          loading = false;
          error = e is AppFailure ? e.message : '转写版本暂时无法读取，文件已保留';
        });
      }
    }
  }

  Future<void> guard(Future<void> Function() action) async {
    if (editing) return;
    setState(() => editing = true);
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (e) {
      if (mounted) {
        setState(() => error = e is AppFailure ? e.message : '操作未完成，请重试');
      }
    } finally {
      if (mounted) setState(() => editing = false);
    }
  }

  Future<void> configure() async {
    if (controller.settings.loading) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => AssemblySettingsPage(settings: controller.settings)));
    if (mounted) setState(() {});
  }

  Future<void> begin() async {
    final config = controller.settings.config;
    if (config == null) {
      await configure();
      return;
    }
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: Text(context.tr('上传并开始转写？')),
                content: SingleChildScrollView(
                    child: Text(context.tr(
                        '将把“{0}”的完整可播放音频上传到 AssemblyAI {1}区域，开启讲话人区分。\n\n语言：{2}；模型：{3}。\n默认逐条上传，最多两条云端任务，可离开页面。iOS 后台查询可能延迟，返回 App 自动同步。\n\n费用由你的 API Key 所属项目承担，本机原件继续保留。关闭页面或暂停查询不会取消云端处理或计费。',
                        [
                      widget.recording.title,
                      config.region == 'eu'
                          ? context.tr('欧盟')
                          : context.tr('美国'),
                      config.language,
                      config.speechModels.join(' / ')
                    ]))),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: Text(context.tr('取消'))),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(context.tr('上传并开始转写')))
                ]));
    if (confirmed == true && mounted) {
      await guard(() =>
          controller.start(widget.recording, durationMs: widget.durationMs));
    }
  }

  Future<void> attach() async {
    var id = '';
    final value = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
                title: Text(context.tr('关联已有任务')),
                content: TextField(
                    autofocus: true,
                    onChanged: (v) => id = v,
                    decoration: InputDecoration(
                        labelText: context.tr('AssemblyAI 任务 ID'))),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text(context.tr('取消'))),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, id),
                      child: Text(context.tr('关联')))
                ]));
    if (value != null && mounted) {
      await guard(() => controller.attach(widget.recording, value));
    }
  }

  Future<void> abandon() async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: Text(context.tr('结束本机跟踪？')),
                content: Text(context.tr(
                    '这不会取消或删除云端任务。请先在 AssemblyAI 控制台核对任务；再次转写可能创建重复任务并产生额外费用。')),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: Text(context.tr('返回核对'))),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(context.tr('已核对，结束跟踪')))
                ]));
    if (confirmed == true && mounted) {
      await guard(() => controller.abandon(widget.recording));
    }
  }

  Future<void> editSegment(Json segment) async {
    final base = revision!;
    final text = TextEditingController(text: segment['text'] as String);
    String? speaker = segment['speakerId'] as String?;
    var reviewed = base.reviewedIds.contains(segment['id']);
    try {
      final saved = await showDialog<bool>(
          context: context,
          builder: (context) => StatefulBuilder(
              builder: (context, setDialog) => AlertDialog(
                      title: Text(context.tr('校对段落')),
                      scrollable: true,
                      content: SizedBox(
                          width: 480,
                          child:
                              Column(mainAxisSize: MainAxisSize.min, children: [
                            TextField(
                                controller: text,
                                minLines: 3,
                                maxLines: 10,
                                decoration: InputDecoration(
                                    labelText: context.tr('文字'))),
                            const SizedBox(height: 16),
                            DropdownButtonFormField<String>(
                                value: speaker ?? '',
                                isExpanded: true,
                                decoration: InputDecoration(
                                    labelText: context.tr('讲话人')),
                                items: [
                                  DropdownMenuItem(
                                      value: '',
                                      child: Text(context.tr('待确认'))),
                                  for (final s in base.speakers)
                                    DropdownMenuItem(
                                        value: s['id'] as String,
                                        child: Text(context.l10n.speaker(s)))
                                ],
                                onChanged: (v) => setDialog(
                                    () => speaker = v == '' ? null : v)),
                            CheckboxListTile(
                                contentPadding: EdgeInsets.zero,
                                title: Text(context.tr('已听原音并核对此段')),
                                value: reviewed,
                                onChanged: (v) =>
                                    setDialog(() => reviewed = v!)),
                            Text(context.tr('修改文字后旧词级时间不再沿用；段落时间用于定位原音。'))
                          ])),
                      actions: [
                        TextButton(
                            onPressed: () => Navigator.pop(context, false),
                            child: Text(context.tr('取消'))),
                        FilledButton(
                            onPressed: () => Navigator.pop(context, true),
                            child: Text(context.tr('保存新版本')))
                      ])));
      if (saved == true && mounted) {
        await guard(() async {
          await controller.store.edit(widget.recording, base.id,
              segmentId: segment['id'] as String,
              text: text.text,
              speakerId: speaker,
              setSpeaker: speaker != segment['speakerId'],
              reviewed: reviewed);
          await controller.reload();
          await load();
        });
      }
    } finally {
      text.dispose();
    }
  }

  Future<void> renameSpeaker(Json speaker) async {
    final base = revision!;
    var value = context.l10n.speaker(speaker);
    final name = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
                title: Text(context.tr('修改人物名称')),
                content: TextFormField(
                    initialValue: value,
                    maxLength: 100,
                    onChanged: (v) => value = v),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text(context.tr('取消'))),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, value),
                      child: Text(context.tr('保存新版本')))
                ]));
    if (name != null && mounted) {
      await guard(() async {
        await controller.store.edit(widget.recording, base.id,
            renameSpeakerId: speaker['id'] as String, speakerName: name);
        await controller.reload();
        await load();
      });
    }
  }

  Future<void> editUntimed() async {
    final base = revision!,
        input = TextEditingController(text: revision!.untimedText);
    try {
      final confirmed = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
                  title: Text(context.tr('校对全文')),
                  scrollable: true,
                  content:
                      TextField(controller: input, minLines: 5, maxLines: 18),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: Text(context.tr('取消'))),
                    FilledButton(
                        onPressed: () => Navigator.pop(context, true),
                        child: Text(context.tr('保存新版本')))
                  ]));
      if (confirmed == true && mounted) {
        await guard(() async {
          await controller.store
              .edit(widget.recording, base.id, untimedText: input.text);
          await controller.reload();
          await load();
        });
      }
    } finally {
      input.dispose();
    }
  }

  Future<void> history() async {
    final snapshot = await controller.store.load(widget.recording);
    if (!mounted) return;
    final id = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        builder: (context) => SafeArea(
            child: ListView.builder(
                itemCount: snapshot.revisions.length,
                itemBuilder: (context, index) {
                  final id = snapshot.revisions.reversed.elementAt(index);
                  return ListTile(
                      title: Text(context.tr('版本 {0}{1}', [
                        snapshot.revisions.length - index,
                        id == snapshot.current ? context.tr(' · 当前') : ''
                      ])),
                      subtitle: Text(id),
                      onTap: () => Navigator.pop(context, id));
                })));
    if (id != null && mounted) {
      selectedId = id == snapshot.current ? null : id;
      await load();
    }
  }

  Future<void> restore() async {
    final head = controller.snapshots[widget.recording.id]?.current;
    if (head == null || selectedId == null) return;
    await guard(() async {
      await controller.store
          .edit(widget.recording, head, restoreId: selectedId);
      selectedId = null;
      await controller.reload();
      await load();
    });
  }

  Future<void> export(String format, {bool share = false}) async =>
      guard(() async {
        // Capture the SAVED revision and full content; UI search never supplies export input.
        final labels = context.l10n.catalog;
        final saved =
            await controller.store.readRevision(widget.recording, revision!.id);
        final current = await controller.library.current(widget.recording.id);
        final output =
                exportTranscript(current.title, saved!, format, labels: labels),
            service =
                widget.exportService ?? TranscriptExportService(labels: labels);
        if (share) {
          await service.share(output);
        } else {
          await service.save(output);
        }
      });
  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshots[widget.recording.id],
        job = snapshot?.latest;
    final busy = controller.busy.contains(widget.recording.id),
        historical = selectedId != null;
    final rows = revision?.segments
            .where((s) =>
                (s['text'] as String)
                    .toLowerCase()
                    .contains(query.toLowerCase()) ||
                context.l10n
                    .speaker(revision!.speakers
                        .where((speaker) => speaker['id'] == s['speakerId'])
                        .firstOrNull)
                    .toLowerCase()
                    .contains(query.toLowerCase()))
            .toList() ??
        <Json>[];
    return ListView.builder(
        key: const Key('transcription-scroll'),
        itemCount: rows.length + 2,
        itemBuilder: (context, index) {
          if (index == 0) {
            return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (widget.audioHeader != null) widget.audioHeader!,
                  Row(children: [
                    Expanded(
                        child: Text(context.tr('转写与校对'),
                            style: Theme.of(context).textTheme.titleLarge)),
                    IconButton(
                        tooltip: context.tr('转写设置'),
                        onPressed: editing ? null : configure,
                        icon: const Icon(Icons.settings_outlined))
                  ]),
                  if (controller.settings.error != null)
                    Text(context.message(controller.settings.error!)),
                  if (job != null) ...[
                    Text(context.message(jobLabel(job.state))),
                    if (job.remoteId != null)
                      SelectableText(context.tr('任务 ID：{0}', [job.remoteId]),
                          style: Theme.of(context).textTheme.bodySmall),
                    if (job.notice != null) Text(context.message(job.notice!)),
                    if (job.state == 'uploading')
                      LinearProgressIndicator(
                          value: controller.progress[widget.recording.id]),
                    if (job.state == 'uploading')
                      TextButton(
                          onPressed: () =>
                              controller.pause(widget.recording.id),
                          child: Text(job.nativeManaged
                              ? context.tr('取消本机上传')
                              : context.tr('暂停上传'))),
                    if (job.polling)
                      TextButton(
                          onPressed: busy || editing
                              ? null
                              : () => unawaited(guard(
                                  () => controller.refresh(widget.recording))),
                          child: Text(context.tr('查询任务进度'))),
                    if (job.state == 'waiting_upload')
                      TextButton(
                          onPressed: () => unawaited(guard(() =>
                              controller.cancelPending(widget.recording))),
                          child: Text(context.tr('取消排队'))),
                    if (job.state == 'uploaded' && !job.nativeManaged)
                      TextButton(
                          onPressed: busy || editing
                              ? null
                              : () => unawaited(guard(() => controller
                                  .continueSubmission(widget.recording))),
                          child: Text(context.tr('继续提交已上传音频'))),
                    if (job.state == 'uncertain')
                      Wrap(spacing: 8, children: [
                        TextButton(
                            onPressed: busy || editing ? null : attach,
                            child: Text(context.tr('关联已有任务'))),
                        TextButton(
                            onPressed: busy || editing ? null : abandon,
                            child: Text(context.tr('结束本机跟踪')))
                      ]),
                  ],
                  if (error != null ||
                      controller.errors[widget.recording.id] != null)
                    Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text(context.message(
                            error ?? controller.errors[widget.recording.id]!))),
                  if (job?.preventsNew != true)
                    FilledButton.icon(
                        onPressed:
                            busy || editing || !widget.canPlay ? null : begin,
                        icon: const Icon(Icons.transcribe),
                        label: Text(revision == null
                            ? context.tr('转写此录音')
                            : context.tr('重新转写'))),
                  if (!widget.canPlay) Text(context.tr('音频可播放后才能开始转写。')),
                  if (loading)
                    const Padding(
                        padding: const EdgeInsets.all(16),
                        child: CircularProgressIndicator()),
                  if (revision != null) ...[
                    const SizedBox(height: 20),
                    Text(context.tr('AssemblyAI · {0} · 已核对 {1}/{2} 段', [
                      revision!.transcript['language'],
                      revision!.reviewedIds.length,
                      revision!.segments.length
                    ])),
                    Text(context.tr('模型：{0}', [
                      mapOf(mapOf(revision!.transcript['provenance'])['asr'])[
                          'model']
                    ])),
                    Text(context.tr('文字、时间与讲话人仍需人工核对；点击段落时间可回听。')),
                    Wrap(spacing: 8, children: [
                      TextButton.icon(
                          onPressed:
                              editing ? null : () => unawaited(guard(history)),
                          icon: const Icon(Icons.history),
                          label: Text(context.tr('历史版本'))),
                      PopupMenuButton<String>(
                          tooltip: context.tr('导出全文'),
                          onSelected: (f) => unawaited(export(f)),
                          itemBuilder: (_) => [
                                for (final f in [
                                  'md',
                                  'txt',
                                  'json',
                                  'srt',
                                  'vtt'
                                ])
                                  PopupMenuItem(
                                      value: f,
                                      child: Text(context
                                          .tr('导出 {0} 全文', [f.toUpperCase()])))
                              ],
                          child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(context.tr('导出全文')))),
                      PopupMenuButton<String>(
                          tooltip: context.tr('系统分享'),
                          onSelected: (f) => unawaited(export(f, share: true)),
                          itemBuilder: (_) => [
                                for (final f in ['md', 'txt', 'json'])
                                  PopupMenuItem(
                                      value: f,
                                      child: Text(context
                                          .tr('分享 {0} 全文', [f.toUpperCase()])))
                              ],
                          child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(context.tr('系统分享'))))
                    ]),
                    if (historical)
                      Card(
                          child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(context.tr('正在查看历史版本，只读预览')),
                                    Wrap(children: [
                                      TextButton(
                                          onPressed: editing ? null : restore,
                                          child: Text(context.tr('恢复为新版本'))),
                                      TextButton(
                                          onPressed: () {
                                            selectedId = null;
                                            unawaited(load());
                                          },
                                          child: Text(context.tr('返回当前版本')))
                                    ])
                                  ]))),
                    const SizedBox(height: 12),
                    TextField(
                        onChanged: (v) => setState(() => query = v),
                        decoration: InputDecoration(
                            labelText: context.tr('搜索转写内容'),
                            prefixIcon: const Icon(Icons.search))),
                    const SizedBox(height: 12),
                    Wrap(spacing: 8, runSpacing: 4, children: [
                      for (final speaker in revision!.speakers)
                        ActionChip(
                            label: Text(context.l10n.speaker(speaker)),
                            onPressed: historical || editing
                                ? null
                                : () => renameSpeaker(speaker))
                    ]),
                    if (rows.isEmpty && query.isNotEmpty)
                      Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(context.tr('没有匹配的段落；导出仍包含全部全文'))),
                  ],
                ]);
          }
          if (index == rows.length + 1) {
            return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (revision?.untimedText.isNotEmpty == true) ...[
                    const SizedBox(height: 16),
                    Text(context.tr('此结果未提供可靠的段落时间，保留全文供校对。')),
                    SelectableText(revision!.untimedText),
                    if (!historical)
                      TextButton(
                          onPressed: editing ? null : editUntimed,
                          child: Text(context.tr('校对全文')))
                  ],
                  if (revision != null &&
                      revision!.segments.isEmpty &&
                      revision!.untimedText.isEmpty)
                    Text(context.tr('未识别到语音内容。')),
                ]);
          }
          final row = rows[index - 1];
          return Card(
              child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 8,
                            children: [
                              TextButton(
                                  onPressed: widget.canPlay
                                      ? () => unawaited(guard(() =>
                                          widget.onSeek(row['startMs'] as int)))
                                      : null,
                                  child: Text(
                                      transcriptTime(row['startMs'] as int))),
                              Text(context.l10n.speaker(revision!.speakers
                                  .where((s) => s['id'] == row['speakerId'])
                                  .firstOrNull)),
                              Text(revision!.reviewedIds.contains(row['id'])
                                  ? context.tr('已核对')
                                  : context.tr('待核对')),
                              if (row['overlap'] == true)
                                Text(context.tr('可能重叠')),
                              if (!historical)
                                IconButton(
                                    tooltip: context.tr('校对此段'),
                                    onPressed:
                                        editing ? null : () => editSegment(row),
                                    icon: const Icon(Icons.edit_outlined))
                            ]),
                        SelectableText(row['text'] as String),
                      ])));
        });
  }
}
