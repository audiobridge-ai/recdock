import 'messages_en.dart';

/// Translates authored labels only; it never mutates saved content.
class MessageCatalog {
  const MessageCatalog([this.language = 'en']);
  final String language;
  String tr(String source, [List<Object?> arguments = const []]) {
    final template = language == 'zh' || language == 'zh-CN'
        ? source
        : englishMessages[source] ?? source;
    // One pass prevents text inside an argument from becoming another placeholder.
    return template.replaceAllMapped(RegExp(r'\{(\d+)\}'), (match) {
      final index = int.parse(match[1]!);
      return index < arguments.length ? '${arguments[index] ?? ''}' : match[0]!;
    });
  }

  /// Existing task journals retain their original authored notices on disk.
  /// Localize those notices at the presentation boundary, without rewriting data.
  String message(String source) {
    if (language == 'zh' || language == 'zh-CN') return source;
    final exact = englishMessages[source];
    if (exact != null) return exact;
    final resume = RegExp(r'^正在从已接收位置恢复（(\d+)/2）$').firstMatch(source);
    if (resume != null) return tr('正在从已接收位置恢复（{0}/2）', [resume[1]]);
    return source;
  }

  String speaker(Map<String, dynamic>? speaker) {
    if (speaker == null) return tr('讲话人待确认');
    final name = speaker['displayName'] as String;
    if (speaker['nameSource'] == 'default') {
      final match = RegExp(r'^说话人 (\d+)$').firstMatch(name);
      if (match != null) return tr('说话人 {0}', [match[1]]);
    }
    return name;
  }
}
