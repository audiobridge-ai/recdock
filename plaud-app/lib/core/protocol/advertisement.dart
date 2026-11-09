import 'dart:convert';
import 'dart:typed_data';

import 'bytes.dart';

const plaudService = '00001910-0000-1000-8000-00805f9b34fb';
const plaudReceive = '00002bb0-0000-1000-8000-00805f9b34fb';
const plaudTransmit = '00002bb1-0000-1000-8000-00805f9b34fb';

const plaudModels = <int, String>{
  888: 'Plaud Note',
  880: 'Plaud NotePin',
  881: 'Plaud Note Pro',
  883: 'Plaud Note Pro',
  882: 'Plaud NotePin S',
  860: 'Plaud One',
};

class PlaudAdvertisement {
  const PlaudAdvertisement(
      {required this.serialNumber,
      required this.project,
      required this.model,
      required this.firmware,
      this.portVersion});
  final String serialNumber;
  final int project;
  final String model;
  final String firmware;
  final int? portVersion;
}

/// Manufacturer payload after removing its two-byte Bluetooth company ID.
/// Layout follows the accepted Web codec; names never establish device identity.
PlaudAdvertisement? decodeAdvertisement(Uint8List bytes) {
  if (bytes.length < 6) return null;
  var versionLength = bytes[0], start = 1, layoutProject = 0;
  if (versionLength == 2) {
    layoutProject = fields(bytes).getUint16(1, Endian.little);
    versionLength = bytes[3];
    start = 4;
  }
  if (versionLength < 1 ||
      versionLength > 5 ||
      start + versionLength >= bytes.length) {
    return null;
  }
  var firmwareNumber = 0;
  for (var i = 1; i < versionLength; i++) {
    firmwareNumber += bytes[start + i] << (8 * (i - 1));
  }
  final snLengthAt = start + versionLength;
  final snLength = bytes[snLengthAt], snAt = snLengthAt + 1;
  if (snLength == 0 || snAt + snLength > bytes.length) return null;
  final serialBytes = bytes.sublist(snAt, snAt + snLength);
  final compact = snLength < 10;
  String serial;
  try {
    serial = compact
        ? hex(serialBytes).toUpperCase()
        : utf8.decode(serialBytes).replaceAll('\u0000', '');
  } on FormatException {
    return null;
  }
  if (serial.length < 3) return null;
  final project = int.tryParse(serial.substring(0, 3));
  final model = plaudModels[project];
  if (model == null) return null;
  int? port;
  if (compact && project != 860) {
    final at = [888, 881, 883].contains(layoutProject) ? 18 : 15;
    if (at + 2 <= bytes.length) {
      final candidate = fields(bytes).getUint16(at, Endian.little);
      if (candidate > 0) port = candidate;
    }
  }
  return PlaudAdvertisement(
      serialNumber: serial,
      project: project!,
      model: model,
      firmware: '${String.fromCharCode(bytes[start])}$firmwareNumber',
      portVersion: port);
}

/// flutter_reactive_ble includes the company ID in manufacturerData on mobile.
PlaudAdvertisement? decodeMobileManufacturer(Uint8List bytes) {
  if (bytes.length < 2) return null;
  final company = fields(bytes).getUint16(0, Endian.little);
  if (company != 0x0046 && company != 0x0059) return null;
  return decodeAdvertisement(Uint8List.sublistView(bytes, 2));
}
