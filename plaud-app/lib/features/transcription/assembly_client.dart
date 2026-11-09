import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import '../../core/failure.dart';
import 'models.dart';

class RequestCancellation {
  bool cancelled = false;
  void Function()? abort;
  void cancel() {
    cancelled = true;
    abort?.call();
  }

  void check() {
    if (cancelled) {
      throw const AppFailure('AAI_CANCELLED', '本机操作已暂停，云端已接收的任务仍可能继续处理和计费');
    }
  }
}

class AssemblyReply {
  const AssemblyReply(this.status, this.body, [this.headers = const {}]);
  final int status;
  final String body;
  final Map<String, String> headers;
}

class AssemblyFailure extends AppFailure {
  const AssemblyFailure(super.code, super.message, {this.retryAfter});
  final Duration? retryAfter;
}

abstract interface class AssemblyTransport {
  Future<AssemblyReply> send(Uri uri,
      {required String method,
      required String apiKey,
      required Stream<List<int>> body,
      required int contentLength,
      required String contentType,
      required RequestCancellation cancellation});
}

class HttpAssemblyTransport implements AssemblyTransport {
  @override
  Future<AssemblyReply> send(Uri uri,
      {required String method,
      required String apiKey,
      required Stream<List<int>> body,
      required int contentLength,
      required String contentType,
      required RequestCancellation cancellation}) async {
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 20);
    cancellation.abort = () => http.close(force: true);
    try {
      cancellation.check();
      return await (() async {
        final request = await http.openUrl(method, uri);
        request.followRedirects = false;
        request.headers.set(HttpHeaders.authorizationHeader, apiKey);
        request.headers.set(HttpHeaders.contentTypeHeader, contentType);
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        request.contentLength = contentLength;
        await request.addStream(body);
        cancellation.check();
        final response = await request.close();
        final builder = BytesBuilder(copy: false);
        var size = 0;
        await for (final part
            in response.timeout(const Duration(seconds: 45))) {
          cancellation.check();
          size += part.length;
          if (size > 32 * 1024 * 1024) {
            throw const AssemblyFailure(
                'AAI_RESPONSE_TOO_LARGE', '转写结果超过本机处理上限，任务 ID 已保留');
          }
          builder.add(part);
        }
        return AssemblyReply(
            response.statusCode, utf8.decode(builder.takeBytes()), {
          if (response.headers.value('retry-after') != null)
            'retry-after': response.headers.value('retry-after')!
        });
      })()
          .timeout(method == 'POST' && uri.path == '/v2/upload'
              ? const Duration(minutes: 15)
              : const Duration(seconds: 60));
    } on AppFailure {
      rethrow;
    } on TimeoutException {
      cancellation.check();
      throw const AssemblyFailure('AAI_TIMEOUT', 'AssemblyAI 请求超时，请检查网络');
    } catch (_) {
      cancellation.check();
      throw const AssemblyFailure('AAI_NETWORK', '无法连接 AssemblyAI，请检查网络后重试');
    } finally {
      cancellation.abort = null;
      http.close(force: true);
    }
  }
}

class AssemblyClient {
  AssemblyClient({AssemblyTransport? transport})
      : transport = transport ?? HttpAssemblyTransport();
  final AssemblyTransport transport;
  Future<Json> _request(
      AssemblyConfig config, String path, RequestCancellation token,
      {String method = 'GET',
      Stream<List<int>>? body,
      int length = 0,
      String contentType = 'application/json'}) async {
    config.validate();
    token.check();
    if (!RegExp(r'^/v2/(upload|transcript(?:/[a-zA-Z0-9_-]{1,160})?)$')
        .hasMatch(path)) {
      throw const AppFailure('AAI_PATH_INVALID', '转写请求路径无效');
    }
    final reply = await transport.send(Uri.parse('${config.baseUrl}$path'),
        method: method,
        apiKey: config.apiKey,
        body: body ?? const Stream.empty(),
        contentLength: length,
        contentType: contentType,
        cancellation: token);
    token.check();
    if (reply.status == 429) {
      final raw = reply.headers['retry-after'];
      var seconds = int.tryParse(raw ?? '');
      if (seconds == null && raw != null) {
        try {
          seconds = HttpDate.parse(raw).difference(DateTime.now()).inSeconds;
        } catch (_) {/* Use bounded fallback. */}
      }
      throw AssemblyFailure('AAI_RATE_LIMIT', 'AssemblyAI 暂时限流，请稍后重试',
          retryAfter: Duration(seconds: (seconds ?? 30).clamp(5, 900)));
    }
    if ([401, 403].contains(reply.status)) {
      throw const AssemblyFailure(
          'AAI_UNAUTHORIZED', 'AssemblyAI Key 无效、项目不匹配或余额/权限不足，请检查设置');
    }
    if (reply.status == 404) {
      throw const AssemblyFailure(
          'AAI_NOT_FOUND', '未找到该区域的转写任务，请核对任务 ID 和 Key');
    }
    if ([400, 413, 415, 422].contains(reply.status)) {
      throw const AssemblyFailure(
          'AAI_REJECTED', 'AssemblyAI 未接受音频或参数，请检查格式、语言和设置');
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw const AssemblyFailure(
          'AAI_SERVICE_ERROR', 'AssemblyAI 服务暂时不可用，请稍后重试');
    }
    try {
      if (utf8.encode(reply.body).length > 32 * 1024 * 1024) {
        throw const FormatException();
      }
      final result = mapOf(jsonDecode(reply.body));
      if (result.isEmpty) throw const FormatException();
      return result;
    } catch (_) {
      throw const AssemblyFailure(
          'AAI_RESPONSE_INVALID', 'AssemblyAI 响应无法识别，任务信息已保留');
    }
  }

  Future<String> upload(AssemblyConfig config, File file,
      RequestCancellation token, void Function(int, int) progress) async {
    final length = await file.length();
    if (length <= 0 || length > 1024 * 1024 * 1024) {
      throw const AppFailure('AAI_AUDIO_INVALID', '请选择不超过 1 GiB 的完整音频');
    }
    var sent = 0;
    Stream<List<int>> stream() async* {
      await for (final part in file.openRead()) {
        token.check();
        sent += part.length;
        progress(sent, length);
        yield part;
      }
      if (sent != length) {
        throw const AppFailure('AAI_AUDIO_CHANGED', '上传中音频发生变化，请重新选择');
      }
    }

    final result = await _request(config, '/v2/upload', token,
        method: 'POST',
        body: stream(),
        length: length,
        contentType: 'application/octet-stream');
    final url =
        result['upload_url'] is String ? result['upload_url'] as String : '';
    if (!validUploadUrl(url)) {
      throw const AssemblyFailure(
          'AAI_UPLOAD_URL_INVALID', 'AssemblyAI 返回的上传地址无法验证');
    }
    return url;
  }

  Future<Json> submit(AssemblyConfig config, TranscriptionJob job,
      RequestCancellation token) async {
    if (!validUploadUrl(job.uploadUrl ?? '')) {
      throw const AppFailure('AAI_UPLOAD_REQUIRED', '音频上传尚未完成');
    }
    final data = utf8.encode(jsonEncode({
      'audio_url': job.uploadUrl,
      'speech_models': job.models,
      'speaker_labels': true,
      'punctuate': true,
      'format_text': true,
      if (job.language == 'auto')
        'language_detection': true
      else
        'language_code': job.language
    }));
    try {
      final response = await _request(config, '/v2/transcript', token,
          method: 'POST', body: Stream.value(data), length: data.length);
      if (!validRemoteId(response['id'] as String? ?? '') ||
          !['queued', 'processing', 'completed', 'error']
              .contains(response['status'])) {
        throw const AssemblyFailure('AAI_RESPONSE_INVALID', '任务响应无效');
      }
      return response;
    } catch (e) {
      if (e is AppFailure &&
          [
            'AAI_REJECTED',
            'AAI_UNAUTHORIZED',
            'AAI_RATE_LIMIT',
            'AAI_NOT_FOUND'
          ].contains(e.code)) {
        rethrow;
      }
      throw const AssemblyFailure('AAI_SUBMIT_UNKNOWN',
          '提交结果尚未确认。请从 AssemblyAI 控制台找到已有任务 ID 后关联，避免重复计费');
    }
  }

  Future<Json> fetch(
      AssemblyConfig config, String id, RequestCancellation token) async {
    if (!validRemoteId(id)) {
      throw const AppFailure('AAI_ID_INVALID', '请输入有效的转写任务 ID');
    }
    final response = await _request(config, '/v2/transcript/$id', token);
    if (response['id'] != id ||
        !['queued', 'processing', 'completed', 'error']
            .contains(response['status'])) {
      throw const AssemblyFailure('AAI_RESPONSE_INVALID', '任务响应无效，已有任务 ID 保留');
    }
    return response;
  }
}

bool validUploadUrl(String url) {
  final uri = Uri.tryParse(url);
  return uri != null &&
      uri.scheme == 'https' &&
      uri.userInfo.isEmpty &&
      !uri.hasPort &&
      !uri.hasFragment &&
      ['cdn.assemblyai.com', 'cdn.eu.assemblyai.com'].contains(uri.host) &&
      uri.path.startsWith('/upload/') &&
      url.length <= 4096;
}
