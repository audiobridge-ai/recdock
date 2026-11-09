class BoundDevice {
  const BoundDevice(
      {required this.serialNumber,
      required this.name,
      this.model,
      this.portVersion,
      this.firmware});
  final String serialNumber;
  final String name;
  final String? model;
  final int? portVersion;
  final String? firmware;
  Map<String, dynamic> toJson() => {
        'serialNumber': serialNumber,
        'name': name,
        'model': model,
        'portVersion': portVersion,
        'firmware': firmware
      };
  factory BoundDevice.fromJson(Map<String, dynamic> row) => BoundDevice(
      serialNumber: row['serialNumber'] as String,
      name: row['name'] as String,
      model: row['model'] as String?,
      portVersion: row['portVersion'] as int?,
      firmware: row['firmware'] as String?);
}

class RsaMaterial {
  const RsaMaterial(
      {required this.publicKeyPem,
      required this.privateKeyPem,
      this.snSignature = '',
      this.history = const []});
  final String publicKeyPem;
  final String privateKeyPem;
  final String snSignature;
  final List<String> history;
  Map<String, dynamic> toJson() => {
        'publicKeyPem': publicKeyPem,
        'privateKeyPem': privateKeyPem,
        'snSignature': snSignature,
        'history': history
      };
  factory RsaMaterial.fromJson(Map<String, dynamic> row) => RsaMaterial(
      publicKeyPem: row['publicKeyPem'] as String,
      privateKeyPem: row['privateKeyPem'] as String,
      snSignature: row['snSignature'] as String? ?? '',
      history: (row['history'] as List? ?? []).cast<String>());
}

class CloudSession {
  CloudSession(
      {required this.userToken,
      required this.userBaseUrl,
      required this.accountId,
      required this.email,
      this.refreshToken,
      this.utExpireAt,
      this.devices = const [],
      this.rsa,
      this.verifiedAt});
  String userToken;
  String userBaseUrl;
  String accountId;
  String email;
  String? refreshToken;
  int? utExpireAt;
  int? verifiedAt;
  List<BoundDevice> devices;
  RsaMaterial? rsa;
  String? workspaceToken, workspaceBaseUrl, workspaceId;

  Map<String, dynamic> toJson() => {
        'userToken': userToken,
        'userBaseUrl': userBaseUrl,
        'accountId': accountId,
        'email': email,
        'refreshToken': refreshToken,
        'utExpireAt': utExpireAt,
        'verifiedAt': verifiedAt,
        'devices': devices.map((d) => d.toJson()).toList()
      };
  factory CloudSession.fromJson(Map<String, dynamic> row) => CloudSession(
      userToken: row['userToken'] as String,
      userBaseUrl: row['userBaseUrl'] as String,
      accountId: row['accountId'] as String,
      email: row['email'] as String,
      refreshToken: row['refreshToken'] as String?,
      utExpireAt: row['utExpireAt'] as int?,
      verifiedAt: row['verifiedAt'] as int?,
      devices: (row['devices'] as List)
          .map((d) => BoundDevice.fromJson(Map<String, dynamic>.from(d as Map)))
          .toList());
}

class DeviceCredentials {
  const DeviceCredentials(
      {required this.accountId,
      required this.serialNumber,
      required this.portVersion,
      this.bindingToken = '',
      this.rsa,
      this.secondExtra8 = '',
      this.secondExtraText = ''});
  final String accountId,
      serialNumber,
      bindingToken,
      secondExtra8,
      secondExtraText;
  final int portVersion;
  final RsaMaterial? rsa;
  String get token => bindingToken.isEmpty ? accountId : bindingToken;
}
