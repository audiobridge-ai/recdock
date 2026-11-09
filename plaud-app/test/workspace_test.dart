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
    expect(find.text('把录音放在一起'), findsOneWidget);
    expect(find.text('导入音频'), findsOneWidget);
    await tester.tap(find.byTooltip('回收站'));
    await tester.pumpAndSettle();
    expect(find.text('回收站是空的'), findsOneWidget);
    await tester.tap(find.text('设备'));
    await tester.pumpAndSettle();
    expect(find.text('扫描附近设备'), findsOneWidget);
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(find.text('你的录音，保存在本机'), findsOneWidget);
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
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(find.byType(ListView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
