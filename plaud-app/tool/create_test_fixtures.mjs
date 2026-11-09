// Synthetic interoperability fixtures only. Never run against user credentials.
import {generateKeyPairSync, publicEncrypt, constants, createCipheriv, createHmac, hkdfSync} from 'node:crypto';
import {secp256k1} from '../../plaud-web/node_modules/@noble/curves/secp256k1.js';
import {spawnSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import {chacha20, chacha20poly1305} from '../../plaud-web/node_modules/@noble/ciphers/chacha.js';

const pair = generateKeyPairSync('rsa', {modulusLength: 2048,
  publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const generated = spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2',
  '-ac','1','-ar','16000','-c:a','libopus','-b:a','32k','-vbr','off','-frame_duration','20','-f','opus','pipe:1']);
if (generated.status !== 0) throw new Error(generated.stderr.toString());
const ogg = new Uint8Array(generated.stdout);
const key = new Uint8Array(32).fill(7), nonce = new Uint8Array(12).fill(9);
const header = Buffer.alloc(512); header.write('PLAUD.AI');
header.writeUInt16LE(1,8); header.writeUInt16LE(512,10);
header.writeUInt16LE(1,48); header.writeUInt16LE(1,50); header.writeUInt16LE(1,52); header.writeUInt32LE(2,54);
header.set(nonce,132); header.set(publicEncrypt({key:pair.publicKey,padding:constants.RSA_PKCS1_PADDING},key),256);
const encrypted = Buffer.concat([header,chacha20(key,nonce,ogg,undefined,0)]);
const material = new Uint8Array(56).map((_,i)=>i+1), sequence = Buffer.from([2,0,0,0,1,3,0]);
const sessionCipher = chacha20poly1305(material.slice(0,32),material.slice(32,44),material.slice(44,56)).encrypt(sequence);
const responseKey=Buffer.from('8rRmMCskL3NaUiGr-UsmEEeI8NKH-ZfeGbpRGqSLpuI=','base64url');
const responsePlain=JSON.stringify({status:0,data:{fixture:true}}), iv=Buffer.alloc(16,3);
const aes=createCipheriv('aes-128-cbc',responseKey.subarray(16),iv);
const unsigned=Buffer.concat([Buffer.from([0x80]),Buffer.alloc(8),iv,aes.update(responsePlain),aes.final()]);
const responseToken=Buffer.concat([unsigned,createHmac('sha256',responseKey.subarray(0,16)).update(unsigned).digest()]).toString('base64url');
const ephemeral=Buffer.alloc(32);ephemeral[31]=2;const server=Buffer.alloc(32);server[31]=1;
const publicPoint=secp256k1.getPublicKey(ephemeral,false), serverPublic=secp256k1.getPublicKey(server,false);
const shared=secp256k1.getSharedSecret(ephemeral,serverPublic,false);
const passwordKey=hkdfSync('sha256',Buffer.concat([publicPoint,shared]),Buffer.alloc(0),Buffer.alloc(0),32);
const passwordCipher=createCipheriv('aes-256-gcm',passwordKey,Buffer.alloc(16,3));
const passwordBody=Buffer.concat([passwordCipher.update(JSON.stringify({pass:'fixture-password',time:1700000000})),passwordCipher.final()]);
const expectedPassword=Buffer.concat([publicPoint,Buffer.alloc(16,3),passwordCipher.getAuthTag(),passwordBody]).toString('base64');
const fixture={...pair,serial:'8880000000000000',sessionId:1700000000,
  ogg:Buffer.from(ogg).toString('base64'),encrypted:encrypted.toString('base64'),
  material:Buffer.from(material).toString('hex'),sessionCipher:Buffer.from(sessionCipher).toString('hex'),responsePlain,responseToken,
  serverPublic:Buffer.from(serverPublic).toString('hex'),expectedPassword};
mkdirSync(new URL('../test/fixtures/',import.meta.url),{recursive:true});
writeFileSync(new URL('../test/fixtures/peer_material.dart',import.meta.url),
  "// Generated synthetic data; contains no user keys, account or recording.\nimport 'dart:convert';\n\nfinal Map<String,dynamic> peerFixture = jsonDecode(r'''"+JSON.stringify(fixture)+"''') as Map<String,dynamic>;\n");
console.log('Created synthetic RSA, encrypted Ogg, session and response fixtures.');
