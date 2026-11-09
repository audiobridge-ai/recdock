import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:plaud_app/features/library/recording_store.dart';

void main() {
  late Directory directory;
  late RecordingStore store;
  late File source;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('recdock-library-test-');
    store = RecordingStore(Directory(p.join(directory.path, 'library')));
    source = await File(p.join(directory.path, '会议.wav'))
        .writeAsBytes(List.generate(128, (i) => i));
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });

  test('导入保留原始字节，重启恢复，且不生成转写任务', () async {
    final recording = await store.importFile(source);
    expect(recording.title, '会议');
    expect(await store.audioFile(recording).readAsBytes(),
        await source.readAsBytes());
    final reloaded = await RecordingStore(store.root).load();
    expect(reloaded.recordings.single.id, recording.id);
    expect(reloaded.unreadableCount, 0);
    expect(
        await Directory(p.join(store.root.path, recording.id, 'jobs')).exists(),
        false);
  });
  test('并发重复导入按内容合并，文件名不影响去重', () async {
    final other = await source.copy(p.join(directory.path, '别名.wav'));
    final records = await Future.wait([
      store.importFile(source),
      store.importFile(other),
      store.importFile(source)
    ]);
    expect(records.map((r) => r.id).toSet(), hasLength(1));
    expect((await store.load()).recordings, hasLength(1));
    expect(
        await store.root
            .list()
            .where((d) => p.basename(d.path).endsWith('.pending'))
            .length,
        0);
  });
  test('改名、回收站和恢复跨重启保存，不改变源文件及哈希', () async {
    final recording = await store.importFile(source);
    await store.setDeleted(recording.id, true);
    // Renaming from an older screen must read the latest deletion state.
    await store.rename(recording.id, '新的标题');
    final deleted = (await RecordingStore(store.root).load()).recordings.single;
    expect(deleted.deleted, true);
    expect(deleted.title, '新的标题');
    expect(deleted.sourceSha256, recording.sourceSha256);
    await store.setDeleted(recording.id, false);
    expect((await store.load()).recordings.single.deleted, false);
    expect(await store.audioFile(recording).readAsBytes(),
        await source.readAsBytes());
  });
  test('重新导入回收站中的同一音频恢复原记录', () async {
    final recording = await store.importFile(source);
    await store.setDeleted(recording.id, true);
    final recovered = await store.importFile(source);
    expect(recovered.id, recording.id);
    expect(recovered.deleted, false);
  });
  test('超限和空文件不入库，失败不破坏后续队列', () async {
    final restricted = RecordingStore(store.root, maxBytes: 64);
    await expectLater(restricted.importFile(source), throwsFormatException);
    final empty =
        await File(p.join(directory.path, 'empty.wav')).writeAsBytes([]);
    await expectLater(restricted.importFile(empty), throwsFormatException);
    final short =
        await File(p.join(directory.path, 'short.wav')).writeAsBytes([1, 2, 3]);
    expect((await restricted.importFile(short)).bytes, 3);
    expect((await restricted.load()).recordings, hasLength(1));
  });
  test('非法标题及未知格式不残留可见或临时录音', () async {
    await expectLater(
        store.importFile(source, title: '  '), throwsFormatException);
    final unknown = await source.copy(p.join(directory.path, 'unknown.bin'));
    await expectLater(store.importFile(unknown), throwsFormatException);
    expect((await store.load()).recordings, isEmpty);
    expect(await store.root.list().length, 0);
    expect(await source.exists(), true);
  });
  test('损坏索引明确计数，正常录音仍然可用，拒绝目录穿越', () async {
    final recording = await store.importFile(source);
    final corrupt = Directory(p.join(store.root.path, 'rec_deadbeef'));
    await corrupt.create();
    await File(p.join(corrupt.path, 'recording.json')).writeAsString('{broken');
    final snapshot = await store.load();
    expect(snapshot.recordings.single.id, recording.id);
    expect(snapshot.unreadableCount, 1);
    final json =
        jsonDecode(jsonEncode(recording.toJson())) as Map<String, dynamic>;
    json['filename'] = '../secret.wav';
    expect(() => LocalRecording.fromJson(json), throwsFormatException);
    await expectLater(store.rename('../escape', 'bad'), throwsFormatException);
  });
}
