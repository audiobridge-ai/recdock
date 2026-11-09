import 'package:flutter/material.dart';
import '../library/recording_store.dart';
import 'models.dart';
import 'transcription_controller.dart';

class TranscriptionTaskCenter extends StatefulWidget {
  const TranscriptionTaskCenter(
      {super.key,
      required this.controller,
      required this.library,
      required this.onOpen});
  final TranscriptionController controller;
  final RecordingStore library;
  final Future<void> Function(LocalRecording) onOpen;
  @override
  State<TranscriptionTaskCenter> createState() => _TaskCenterState();
}

class _TaskCenterState extends State<TranscriptionTaskCenter> {
  final recordings = <String, LocalRecording>{};
  String? error;
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(changed);
    reload();
  }

  void changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.removeListener(changed);
    super.dispose();
  }

  Future<void> reload() async {
    try {
      final rows =
          (await widget.library.load()).recordings.where((r) => !r.deleted);
      if (!mounted) return;
      recordings
        ..clear()
        ..addEntries(rows.map((r) => MapEntry(r.id, r)));
      await widget.controller.poll();
      if (mounted) setState(() => error = null);
    } catch (_) {
      if (mounted) setState(() => error = '任务暂时无法刷新，记录已保留');
    }
  }

  Future<void> cancel(LocalRecording r) async {
    try {
      await widget.controller.cancelPending(r);
    } catch (_) {
      if (mounted) setState(() => error = '任务状态已变化，请刷新后查看；已提交任务继续在云端执行');
    }
  }

  @override
  Widget build(BuildContext context) {
    final tasks = widget.controller.snapshots.values
        .expand((s) => s.jobs)
        .where((j) => recordings.containsKey(j.recordingId))
        .toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return Scaffold(
        appBar: AppBar(title: const Text('转写任务'), actions: [
          IconButton(
              tooltip: '刷新任务',
              onPressed: reload,
              icon: const Icon(Icons.refresh))
        ]),
        body: Column(children: [
          const Padding(
              padding: EdgeInsets.all(20),
              child: Text(
                  '按顺序上传，每次上传 1 条，最多 2 条云端任务。可以离开页面或锁屏，已提交的转写继续在云端进行。\n\niOS 的后续查询与排队任务由系统安排，返回 App 会自动同步。完成提醒需要通知权限，提醒可能延迟。')),
          if (widget.controller.errors['background'] != null)
            Padding(
                padding: const EdgeInsets.all(12),
                child: Text(widget.controller.errors['background']!)),
          if (error != null)
            Padding(padding: const EdgeInsets.all(12), child: Text(error!)),
          Expanded(
              child: tasks.isEmpty
                  ? const Center(child: Text('还没有转写任务'))
                  : RefreshIndicator(
                      onRefresh: reload,
                      child: ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          itemCount: tasks.length,
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemBuilder: (context, i) {
                            final job = tasks[i],
                                r = recordings[job.recordingId]!;
                            return ListTile(
                                title: Text(r.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis),
                                subtitle: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(jobLabel(job.state)),
                                      if (job.notice != null) Text(job.notice!),
                                      if (widget.controller.errors[r.id] !=
                                          null)
                                        Text(widget.controller.errors[r.id]!),
                                      if (job.state == 'uploading')
                                        LinearProgressIndicator(
                                            value: widget
                                                .controller.progress[r.id]),
                                    ]),
                                trailing: job.nativeManaged &&
                                        [
                                          'waiting_upload',
                                          'uploading',
                                          'uploaded'
                                        ].contains(job.state)
                                    ? IconButton(
                                        tooltip: '取消本机任务',
                                        onPressed: () => cancel(r),
                                        icon: const Icon(Icons.close))
                                    : const Icon(Icons.chevron_right),
                                onTap: () => widget.onOpen(r));
                          }))),
        ]));
  }
}
