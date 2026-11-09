/// UI-safe failures deliberately exclude raw responses, keys and nested causes.
class AppFailure implements Exception {
  const AppFailure(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}
