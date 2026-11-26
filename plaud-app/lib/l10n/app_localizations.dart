import 'package:flutter/widgets.dart';

import 'message_catalog.dart';

/// Authored UI copy only. Never pass recording titles, transcript text, or user names.
class AppLocalizations {
  const AppLocalizations(this.locale);
  final Locale locale;
  static const supportedLocales = [Locale('en'), Locale('zh', 'CN')];

  static AppLocalizations of(BuildContext context) =>
      AppLocalizations(Localizations.localeOf(context));

  MessageCatalog get catalog => MessageCatalog(locale.languageCode);
  String tr(String source, [List<Object?> arguments = const []]) =>
      catalog.tr(source, arguments);
  String message(String source) => catalog.message(source);
  String speaker(Map<String, dynamic>? speaker) => catalog.speaker(speaker);
}

extension LocalizedContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
  String tr(String source, [List<Object?> arguments = const []]) =>
      l10n.tr(source, arguments);
  String message(String source) => l10n.message(source);
}
