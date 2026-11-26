import 'package:flutter/material.dart';

import 'app.dart';
import 'l10n/language_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final language = LanguageController();
  await language.restore();
  runApp(RecDockApp(language: language));
}
