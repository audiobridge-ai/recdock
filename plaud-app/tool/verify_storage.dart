// A server-free filesystem integration check for restricted build environments.
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:plaud_app/features/library/recording_store.dart';

void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> main() async {
  final directory =
      await Directory.systemTemp.createTemp('recdock-storage-verify-');
  try {
    final store = RecordingStore(Directory(p.join(directory.path, 'library')));
    final source = await File(p.join(directory.path, 'test.wav'))
        .writeAsBytes(List.generate(128, (i) => i));
    final originals = await source.readAsBytes();
    final records = await Future.wait([
      store.importFile(source),
      store.importFile(source),
      store.importFile(source)
    ]);
    check(records.map((r) => r.id).toSet().length == 1,
        'Concurrent deduplication failed');
    check((await store.load()).recordings.length == 1,
        'Duplicate records published');
    final recording = records.first;
    check(
        base64Encode(await store.audioFile(recording).readAsBytes()) ==
            base64Encode(originals),
        'Original changed');
    check(
        !await Directory(p.join(store.root.path, recording.id, 'jobs'))
            .exists(),
        'Implicit transcription created');
    await store.setDeleted(recording.id, true);
    await store.rename(recording.id, 'renamed');
    final persisted =
        (await RecordingStore(store.root).load()).recordings.single;
    check(persisted.deleted && persisted.title == 'renamed',
        'Stale update lost deletion state');
    check(persisted.sourceSha256 == recording.sourceSha256,
        'Rename changed source identity');
    final restored = await store.importFile(source);
    check(restored.id == recording.id && !restored.deleted,
        'Duplicate import did not restore');
    final restrictive = RecordingStore(store.root, maxBytes: 64);
    var rejected = false;
    try {
      await restrictive.importFile(source);
    } on FormatException {
      rejected = true;
    }
    check(rejected, 'Oversize input accepted');
    final short =
        await File(p.join(directory.path, 'short.wav')).writeAsBytes([1, 2, 3]);
    check((await restrictive.importFile(short)).bytes == 3,
        'Failed operation poisoned queue');
    rejected = false;
    try {
      await store.importFile(source, title: '  ');
    } on FormatException {
      rejected = true;
    }
    // A duplicate import intentionally preserves its existing title.
    final unique = await File(p.join(directory.path, 'unique.wav'))
        .writeAsBytes([5, 4, 3, 2, 1]);
    try {
      await store.importFile(unique, title: '  ');
    } on FormatException {
      rejected = true;
    }
    check(rejected, 'Empty title accepted for new record');
    check(
        await store.root
                .list()
                .where((e) => p.basename(e.path).endsWith('.pending'))
                .length ==
            0,
        'Temporary import leaked');
    final corrupt = Directory(p.join(store.root.path, 'rec_deadbeef'));
    await corrupt.create();
    await File(p.join(corrupt.path, 'recording.json')).writeAsString('{broken');
    final snapshot = await store.load();
    check(snapshot.unreadableCount == 1 && snapshot.recordings.length == 2,
        'Corrupt index hid healthy recordings');
    final unsafe = recording.toJson()..['filename'] = '../outside.wav';
    rejected = false;
    try {
      LocalRecording.fromJson(unsafe);
    } on FormatException {
      rejected = true;
    }
    check(rejected, 'Path traversal accepted');
    check(base64Encode(await source.readAsBytes()) == base64Encode(originals),
        'Source file changed');
    stdout.writeln('Storage integration: 14/14 checks passed');
  } finally {
    await directory.delete(recursive: true);
  }
}
