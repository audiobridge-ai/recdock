import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

abstract interface class LanguagePreferences {
  Future<String?> read();
  Future<void> write(String language);
}

/// Non-secret, app-wide preferences. Native background notifications use the same value.
class NativeLanguagePreferences implements LanguagePreferences {
  static const channel = MethodChannel('ai.audiobridge.recdock/localization');
  @override
  Future<String?> read() => channel.invokeMethod<String>('getLanguage');
  @override
  Future<void> write(String language) =>
      channel.invokeMethod<void>('setLanguage', {'language': language});
}

class LanguageController extends ChangeNotifier {
  LanguageController({LanguagePreferences? preferences, String language = 'en'})
      : _preferences = preferences ?? NativeLanguagePreferences(),
        _language = normalize(language);
  final LanguagePreferences _preferences;
  String _language;
  bool _saving = false;
  String get language => _language;
  Locale get locale =>
      _language == 'zh-CN' ? const Locale('zh', 'CN') : const Locale('en');
  static String normalize(String? value) => value == 'zh-CN' ? 'zh-CN' : 'en';

  Future<void> restore() async {
    try {
      _language = normalize(await _preferences.read());
    } catch (_) {
      _language = 'en';
    }
    notifyListeners();
  }

  Future<void> select(String language) async {
    if (!['en', 'zh-CN'].contains(language))
      throw ArgumentError.value(language);
    if (_saving || language == _language) return;
    _saving = true;
    try {
      await _preferences.write(language);
      _language = language;
      notifyListeners();
    } finally {
      _saving = false;
    }
  }
}

class LanguageScope extends InheritedNotifier<LanguageController> {
  const LanguageScope(
      {super.key, required LanguageController controller, required super.child})
      : super(notifier: controller);
  static LanguageController of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<LanguageScope>()!.notifier!;
}
