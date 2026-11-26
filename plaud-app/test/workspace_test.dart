import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:plaud_app/app.dart';
import 'package:plaud_app/features/library/recording_store.dart';

class EmptyRecordingStore extends RecordingStore {
  EmptyRecordingStore() : super(Directory.systemTemp);
  @override
  Future<LibrarySnapshot> load() async => const LibrarySnapshot([], 0);
}

void main() {
  testWidgets('无账号和设备可打开录音库，导航和回收站正常', (tester) async {
    await tester.pumpWidget(RecDockApp(store: EmptyRecordingStore()));
    await tester.pumpAndSettle();
    expect(find.text('All your recordings in one place'), findsOneWidget);
    expect(find.text('Import audio'), findsOneWidget);
    await tester.tap(find.byTooltip('Trash'));
    await tester.pumpAndSettle();
    expect(find.text('Trash is empty'), findsOneWidget);
    await tester.tap(find.text('Devices'));
    await tester.pumpAndSettle();
    expect(find.text('Scan nearby devices'), findsOneWidget);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Your recordings, stored locally'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('窄屏及大字体设置页面可滚动且没有布局溢出', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(RecDockApp(store: EmptyRecordingStore()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.byType(ListView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
