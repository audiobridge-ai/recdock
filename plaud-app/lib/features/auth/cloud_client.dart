import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../../core/crypto/protocol_crypto.dart';
import '../../core/failure.dart';
import '../../core/protocol/bytes.dart';
import 'models.dart';

typedef Json = Map<String, dynamic>;
Json object(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : {};
String string(dynamic value) => value is String ? value : '';
bool validToken(String value) =>
    value.isNotEmpty &&
    value.length <= 8192 &&
    RegExp(r'^[a-z\d._~+/\-]+=*$', caseSensitive: false).hasMatch(value);
bool validPort(dynamic value) => value is int && value >= 1 && value <= 65535;

String officialBase(String value) {
  if (!RegExp(r'^https://api(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.plaud\.ai/?$',
          caseSensitive: false)
      .hasMatch(value)) {
    throw const AppFailure('UNSAFE_API_HOST', '账号区域地址不受支持');
  }
  return Uri.parse(value).origin;
}

class CloudResponse {
  const CloudResponse(this.status, this.headers, this.body);
  final int status;
  final Map<String, String> headers;
  final String body;
}

abstract interface class CloudTransport {
  Future<CloudResponse> send(Uri uri,
      {required String method,
      required Map<String, String> headers,
      String? body});
}

class HttpCloudTransport implements CloudTransport {
  @override
  Future<CloudResponse> send(Uri uri,
      {required String method,
      required Map<String, String> headers,
      String? body}) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 15);
    try {
      return await (() async {
        final request = await client.openUrl(method, uri);
        request.followRedirects = false;
        headers.forEach(request.headers.set);
        if (body != null) request.add(utf8.encode(body));
        final response = await request.close();
        final bytes = BytesBuilder();
        var length = 0;
        if (response.contentLength > 1024 * 1024) {
          throw const AppFailure('RESPONSE_TOO_LARGE', '云端响应超过允许大小');
        }
        await for (final part in response) {
          length += part.length;
          if (length > 1024 * 1024) {
            throw const AppFailure('RESPONSE_TOO_LARGE', '云端响应超过允许大小');
          }
          bytes.add(part);
        }
        final responseHeaders = <String, String>{};
        response.headers.forEach((name, values) =>
            responseHeaders[name.toLowerCase()] = values.join(','));
        return CloudResponse(response.statusCode, responseHeaders,
            utf8.decode(bytes.takeBytes()));
      })()
          .timeout(const Duration(seconds: 15));
    } on AppFailure {
      rethrow;
    } on TimeoutException {
      throw const AppFailure('CLOUD_TIMEOUT', '账号请求超时，请重试');
    } catch (_) {
      throw const AppFailure('CLOUD_NETWORK_ERROR', '无法连接 PLAUD，请检查网络后重试');
    } finally {
      client.close(force: true);
    }
  }
}

class PlaudCloudClient {
  PlaudCloudClient({CloudTransport? transport})
      : transport = transport ?? HttpCloudTransport();
  final CloudTransport transport;
  Future<void> Function(CloudSession session)? onTokensChanged;
  final Map<String,
          Future<({String token, String refresh, int? expiry, String base})>>
      _refreshes = {};
  final Expando<int> _proactiveAttempts = Expando<int>();
  final Map<String, ({Uint8List key, int expires})> _security = {};

  Future<Json> _once(CloudSession session, String path,
      {String method = 'GET',
      String? body,
      String? contentType,
      bool workspace = false,
      bool workspaceBase = false,
      String? baseUrl,
      String? authToken,
      Map<String, String> extraHeaders = const {},
      bool refreshing = false}) async {
    if (!path.startsWith('/') ||
        path.startsWith('//') ||
        RegExp(r'[\r\n\\]').hasMatch(path)) {
      throw const AppFailure('INVALID_REQUEST', '账号请求路径无效');
    }
    if (workspace && session.workspaceToken == null) {
      throw const AppFailure('WORKSPACE_REQUIRED', '需要个人工作区授权');
    }
    final useWorkspaceBase = workspace || workspaceBase;
    var base = officialBase(baseUrl ??
        (useWorkspaceBase
            ? session.workspaceBaseUrl ?? session.userBaseUrl
            : session.userBaseUrl));
    for (var attempt = 0; attempt < 2; attempt++) {
      final token =
          authToken ?? (workspace ? session.workspaceToken : session.userToken);
      final response = await transport
          .send(Uri.parse('$base$path'), method: method, body: body, headers: {
        'Accept': 'application/json',
        'app-platform': 'android',
        'edit-from': 'android',
        'app-version': '4.1.0 (1289)',
        'app-versionNumber': '4.1.0',
        'app-buildNumber': '1289',
        'app-language': 'zh-CN',
        'User-Agent': 'RecDock-App/0.1.0',
        'X-Encrypt-Response': '1',
        'app-refresh-token-flag': '1',
        if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
        if (contentType != null) 'Content-Type': contentType,
        ...extraHeaders,
      });
      if (response.status >= 300 && response.status < 400) {
        throw const AppFailure('HTTP_REDIRECT_BLOCKED', '账号服务返回了不允许的跳转');
      }
      if (response.status == 401) {
        if (path == '/auth/access-token') {
          throw const AppFailure('LOGIN_REJECTED', '邮箱或密码不正确，请检查后重试');
        }
        throw const AppFailure('SESSION_EXPIRED', '账号登录已失效，请重新登录');
      }
      if (response.status == 403) {
        throw const AppFailure(
            'UPSTREAM_ACCESS_DENIED', 'PLAUD 拒绝访问，请检查账号授权或网络');
      }
      Json envelope;
      if (utf8.encode(response.body).length > 1024 * 1024) {
        throw const AppFailure('RESPONSE_TOO_LARGE', '云端响应超过允许大小');
      }
      try {
        final text = response.headers['x-encrypt-response'] == '1'
            ? decryptCloudResponse(response.body)
            : response.body;
        envelope = object(jsonDecode(text));
        if (envelope.isEmpty) throw const FormatException();
      } on AppFailure {
        rethrow;
      } catch (_) {
        throw const AppFailure('INVALID_CLOUD_RESPONSE', 'PLAUD 返回的数据无法识别');
      }
      if (response.status == 409 && refreshing && envelope['status'] == -4302) {
        throw const AppFailure('TOKEN_REFRESH_CONFLICT', '登录续期冲突，请稍后重试');
      }
      if (response.status < 200 || response.status >= 300) {
        throw const AppFailure('UPSTREAM_HTTP_ERROR', 'PLAUD 请求未成功，请稍后重试');
      }
      if (envelope['status'] == -302) {
        if (attempt > 0) {
          throw const AppFailure('REGION_REDIRECT_LIMIT', '账号区域切换未完成');
        }
        final data = object(envelope['data']),
            region = object(object(envelope['data'])['region']);
        base = officialBase(string(data['api'] ??
            data['api_domain'] ??
            object(data['domains'])['api'] ??
            object(data['region_domains'])['api'] ??
            region['api'] ??
            object(region['domains'])['api']));
        if (useWorkspaceBase) {
          session.workspaceBaseUrl = base;
        } else {
          session.userBaseUrl = base;
        }
        continue;
      }
      if (envelope['status'] == 10001) {
        throw const AppFailure('MFA_REQUIRED', '请先在 PLAUD 官方应用完成账号额外验证');
      }
      if (envelope['status'] != null && envelope['status'] != 0) {
        throw const AppFailure(
            'CLOUD_REQUEST_REJECTED', 'PLAUD 未接受请求，请检查账号后重试');
      }
      return envelope;
    }
    throw const AppFailure('REGION_REDIRECT_LIMIT', '账号区域切换未完成');
  }

  Future<Json> _get(CloudSession session, String path) async {
    if (session.userToken.isNotEmpty) await _refreshIfNeeded(session);
    final used = session.userToken;
    try {
      return await _once(session, path);
    } on AppFailure catch (error) {
      if (error.code != 'SESSION_EXPIRED' || session.refreshToken == null) {
        rethrow;
      }
      if (session.userToken == used) await refresh(session);
      return _once(session, path);
    }
  }

  Future<void> _refreshIfNeeded(CloudSession session) async {
    final token = session.refreshToken;
    if (token == null) return;
    if (_refreshes.containsKey(token)) {
      await refresh(session);
      return;
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    if (session.utExpireAt == null || session.utExpireAt! > now ~/ 1000 + 300) {
      return;
    }
    if (now - (_proactiveAttempts[session] ?? 0) < 60000) return;
    _proactiveAttempts[session] = now;
    await refresh(session);
  }

  Future<void> refresh(CloudSession session) async {
    final old = session.refreshToken;
    if (old == null || !validToken(old)) {
      throw const AppFailure('SESSION_EXPIRED', '登录已过期，请重新登录');
    }
    final pending = _refreshes.putIfAbsent(old, () async {
      final context = CloudSession(
          userToken: session.userToken,
          userBaseUrl: session.userBaseUrl,
          accountId: session.accountId,
          email: session.email);
      for (var attempt = 0;; attempt++) {
        try {
          final pair = await _once(context, '/auth/refresh-user-token',
              method: 'POST',
              body: '',
              contentType: 'application/json',
              authToken: old,
              refreshing: true);
          final token = string(pair['access_token']),
              next = string(pair['refresh_token']);
          if (!validToken(token) || !validToken(next)) {
            throw const AppFailure(
                'REFRESH_TOKEN_PAIR_INVALID', 'PLAUD 未返回完整续期凭据');
          }
          return (
            token: token,
            refresh: next,
            expiry: pair['ut_expire_at'] is int
                ? pair['ut_expire_at'] as int
                : null,
            base: context.userBaseUrl
          );
        } on AppFailure catch (error) {
          if (error.code != 'TOKEN_REFRESH_CONFLICT' || attempt >= 2) rethrow;
          await Future<void>.delayed(const Duration(seconds: 1));
        }
      }
    });
    try {
      final pair = await pending;
      if (session.refreshToken != old) {
        if (session.refreshToken == pair.refresh &&
            session.userToken == pair.token) {
          return;
        }
        throw const AppFailure('SESSION_CHANGED', '账号已改变，请重试');
      }
      session.userToken = pair.token;
      session.refreshToken = pair.refresh;
      session.utExpireAt = pair.expiry;
      session.userBaseUrl = pair.base;
      _proactiveAttempts[session] = DateTime.now().millisecondsSinceEpoch;
      await onTokensChanged?.call(session);
    } finally {
      if (identical(_refreshes[old], pending)) _refreshes.remove(old);
    }
  }

  Future<CloudSession> login(String email, String password) async {
    if (email.trim().isEmpty ||
        email.length > 320 ||
        password.isEmpty ||
        password.length > 4096) {
      throw const AppFailure('LOGIN_INPUT_INVALID', '请填写有效的邮箱和密码');
    }
    final session = CloudSession(
        userToken: '',
        userBaseUrl: 'https://api.plaud.ai',
        accountId: '',
        email: email.trim());
    var value = password, encrypted = false;
    final base = session.userBaseUrl, cached = _security[session.userBaseUrl];
    Uint8List? publicKey =
        cached != null && cached.expires > DateTime.now().millisecondsSinceEpoch
            ? cached.key
            : null;
    if (publicKey == null) {
      Json? configuration;
      try {
        configuration = await _get(session, '/config/security');
      } on AppFailure catch (error) {
        if (![
          'UPSTREAM_HTTP_ERROR',
          'CLOUD_NETWORK_ERROR',
          'CLOUD_TIMEOUT',
          'INVALID_CLOUD_RESPONSE',
          'CLOUD_REQUEST_REJECTED',
          'RESPONSE_TOO_LARGE'
        ].contains(error.code)) {
          rethrow;
        }
      }
      final data = object(configuration?['data']),
          encoded = string(object(configuration?['data'])['pass_pub_key']);
      if (data['pass_algorithm'] == 'secp256k1' &&
          RegExp(r'^(?:02[\da-f]{64}|03[\da-f]{64}|04[\da-f]{128})$',
                  caseSensitive: false)
              .hasMatch(encoded)) {
        publicKey = unhex(encoded);
        _security[base] = (
          key: publicKey,
          expires: DateTime.now().millisecondsSinceEpoch + 300000
        );
      }
    }
    if (publicKey != null) {
      value = encryptLoginPassword(password, publicKey);
      encrypted = true;
    }
    final form = Uri(queryParameters: {
      'username': email.trim(),
      'password': value,
      'password_encrypted': '$encrypted',
      'client_id': 'android'
    }).query;
    final result = await _once(session, '/auth/access-token',
        method: 'POST',
        body: form,
        contentType: 'application/x-www-form-urlencoded');
    final token = string(result['access_token']),
        rt = string(result['refresh_token']);
    if (!validToken(token) || (rt.isNotEmpty && !validToken(rt))) {
      throw const AppFailure('LOGIN_TOKEN_MISSING', '登录凭据不完整，请重试');
    }
    session.userToken = token;
    session.refreshToken = rt.isEmpty ? null : rt;
    session.utExpireAt =
        result['ut_expire_at'] is int ? result['ut_expire_at'] as int : null;
    await _profile(session);
    await devices(session);
    return session;
  }

  Future<CloudSession> importSession(String token, String baseUrl) async {
    token = token
        .trim()
        .replaceFirst(RegExp(r'^bearer\s+', caseSensitive: false), '');
    if (!validToken(token)) {
      throw const AppFailure('SESSION_INPUT_INVALID', '登录态格式无效');
    }
    final session = CloudSession(
        userToken: token,
        userBaseUrl: officialBase(baseUrl),
        accountId: '',
        email: '');
    await _profile(session);
    await devices(session);
    return session;
  }

  Future<void> _profile(CloudSession session) async {
    final profile =
        await _get(session, '/user-app/profile/account/me?setting&passport');
    final data = object(profile['data']),
        basic = object(object(profile['data'])['basic']);
    final id = string(basic['user_id']);
    if (id.trim().isEmpty) {
      throw const AppFailure('ACCOUNT_ID_MISSING', 'PLAUD 未返回账号身份');
    }
    session.accountId = id;
    session.email = string(object(data['passport'])['email']).isNotEmpty
        ? string(object(data['passport'])['email'])
        : session.email;
  }

  Future<void> restore(CloudSession session) async {
    if (!validToken(session.userToken) ||
        session.accountId.isEmpty ||
        (session.refreshToken != null && !validToken(session.refreshToken!))) {
      throw const AppFailure('SESSION_INPUT_INVALID', '保存的登录态无效，请重新登录');
    }
    officialBase(session.userBaseUrl);
    final expected = session.accountId;
    await _profile(session);
    if (session.accountId != expected) {
      throw const AppFailure('SESSION_ACCOUNT_MISMATCH', '账号身份发生变化，请重新登录');
    }
    await devices(session);
    session.workspaceToken = null;
  }

  Future<List<BoundDevice>> devices(CloudSession session) async {
    final response = await _get(session, '/device-app/device/list');
    if (response['data_devices'] is! List) {
      throw const AppFailure('DEVICE_LIST_INVALID', '设备列表格式无法识别');
    }
    session.devices = (response['data_devices'] as List)
        .map(object)
        .where((r) => RegExp(r'^[a-z\d_-]{1,128}$', caseSensitive: false)
            .hasMatch(string(r['sn'])))
        .map((r) => BoundDevice(
            serialNumber: string(r['sn']),
            name: string(r['name']).isNotEmpty
                ? string(r['name'])
                : string(r['model']).isNotEmpty
                    ? string(r['model'])
                    : 'PLAUD 设备',
            model: string(r['model']),
            portVersion:
                validPort(r['prot_version']) ? r['prot_version'] as int : null,
            firmware: r['version_number']?.toString()))
        .toList();
    return session.devices;
  }

  Future<DeviceCredentials> prepare(
      CloudSession session, String serial, int port) async {
    if (!validPort(port)) {
      throw const AppFailure('PORT_VERSION_REQUIRED', '未取得设备协议版本，请重新扫描');
    }
    if (port == 30) {
      throw const AppFailure(
          'UNSUPPORTED_AUTO_ECC', '此设备使用 ECC 协议，当前版本尚未支持自动认证');
    }
    await _refreshIfNeeded(session);
    await devices(session);
    if (!session.devices.any((d) => d.serialNumber == serial)) {
      throw const AppFailure('DEVICE_NOT_BOUND', '设备不属于当前登录账号');
    }
    if (port != 20) {
      return DeviceCredentials(
          accountId: session.accountId,
          serialNumber: serial,
          portVersion: port);
    }
    final signatures = await _once(session, '/device-app/device/sn-sign',
        method: 'POST',
        body: jsonEncode({
          'sns': [serial]
        }),
        contentType: 'application/json');
    final encoded =
        string(object(object(signatures['data'])['signature'])[serial])
            .replaceAll(RegExp(r'\s'), '');
    String signature;
    try {
      final bytes = base64Decode(base64.normalize(encoded));
      if (bytes.isEmpty ||
          bytes.length > 25500 ||
          base64Encode(bytes).replaceAll('=', '') !=
              encoded.replaceAll('=', '')) {
        throw const FormatException();
      }
      signature = base64Encode(bytes);
    } catch (_) {
      throw const AppFailure('SN_SIGNATURE_INVALID', '设备认证签名格式无效');
    }
    var pair = session.rsa;
    if (pair == null) {
      await _workspace(session);
      Json keys;
      try {
        keys = await _once(session, '/device-app/e2ee/gen_key',
            method: 'POST',
            body: '{}',
            contentType: 'application/json',
            workspace: true);
      } on AppFailure catch (e) {
        if (e.code == 'SESSION_EXPIRED') {
          session.workspaceToken = null;
          throw const AppFailure('WORKSPACE_SESSION_EXPIRED', '工作区授权过期，请重试连接');
        }
        rethrow;
      }
      final data = object(keys['data']);
      String pem(String plain, String encoded) =>
          string(data[plain]).trim().isNotEmpty
              ? string(data[plain])
              : utf8.decode(base64Decode(string(data[encoded])));
      try {
        final public = pem('public_key', 'public_key_base64'),
            private = pem('private_key', 'private_key_base64');
        validateRsaPair(public, private);
        pair = RsaMaterial(publicKeyPem: public, privateKeyPem: private);
      } catch (_) {
        throw const AppFailure('RSA_KEYS_INVALID', '账号密钥材料无效或不匹配');
      }
    }
    validateRsaPair(pair.publicKeyPem, pair.privateKeyPem);
    pair = RsaMaterial(
        publicKeyPem: pair.publicKeyPem,
        privateKeyPem: pair.privateKeyPem,
        snSignature: signature,
        history: pair.history);
    session.rsa = pair;
    return DeviceCredentials(
        accountId: session.accountId,
        serialNumber: serial,
        portVersion: port,
        rsa: pair);
  }

  Future<void> _workspace(CloudSession session) async {
    if (session.workspaceToken != null && session.workspaceBaseUrl != null) {
      return;
    }
    final envelope = await _get(session,
        '/team-app/workspaces/list?need_personal_workspace=true&include_details=true');
    final data = envelope['data'];
    final rows = data is List
        ? data
        : object(data)['workspaces'] ??
            object(data)['list'] ??
            object(data)['items'] ??
            object(data)['records'];
    if (rows is! List) throw const AppFailure('WORKSPACE_REQUIRED', '未找到个人工作区');
    final personal = rows.map(object).where((row) {
      final type = row['workspace_type'],
          named = string(row['type']).toUpperCase();
      if (named == 'TEAM' || string(type).toUpperCase() == 'TEAM') return false;
      if (type is int) return type != 1;
      if (type is String && int.tryParse(type) != null) {
        return int.parse(type) != 1;
      }
      return string(type).toUpperCase() == 'PERSONAL' || named == 'PERSONAL';
    });
    if (personal.isEmpty) {
      throw const AppFailure('WORKSPACE_REQUIRED', '账号没有可用的个人工作区');
    }
    final row = personal.first,
        id = string(personal.first['workspace_id'] ?? personal.first['id']);
    if (id.isEmpty || id.length > 128 || RegExp(r'[\r\n]').hasMatch(id)) {
      throw const AppFailure('WORKSPACE_REQUIRED', '个人工作区标识无效');
    }
    final domain =
        string(row['api_domain'] ?? object(row['domains'])['api']).trim();
    session.workspaceBaseUrl = domain.isEmpty
        ? session.userBaseUrl
        : officialBase(domain.contains('://') ? domain : 'https://$domain');
    final grant = await _once(
        session, '/user-app/auth/workspace/token/${Uri.encodeComponent(id)}',
        method: 'POST',
        workspaceBase: true,
        extraHeaders: {'X-Region-Workspace-Id': id});
    final result = object(grant['data']),
        token = string(object(grant['data'])['workspace_token'] ??
            object(grant['data'])['access_token']);
    if (token.isEmpty || string(result['refresh_token']).isEmpty) {
      throw const AppFailure('WORKSPACE_REQUIRED', '个人工作区授权不完整');
    }
    session.workspaceToken = token;
    session.workspaceId = id;
  }
}
