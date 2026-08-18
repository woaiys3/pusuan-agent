#!/usr/bin/env node
/**
 * 把 assets/ 目录追加进 APK（zip）—— 支持 UTF-8 中文文件名
 * 用法: node pack-assets.js <apk> <assetsDir>
 * APK 本质是 zip；本工具读取现有 zip 结构，追加 assets/ 下的所有文件为 zip 条目，
 * 更新中央目录与 EOCD。中文文件名以 UTF-8 存储（zip flag bit 11），
 * Android AssetManager 读取时按 UTF-8 解码，知识库中文路径完整保留。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [APK, ASSETS] = process.argv.slice(2);
if (!APK || !ASSETS) { console.error('用法: node pack-assets.js <apk> <assetsDir>'); process.exit(1); }

// ── CRC32 ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── 读现有 zip 结构 ──
const apk = fs.readFileSync(APK);
// 找 EOCD
let eocd = -1;
for (let i = apk.length - 22; i >= 0; i--) {
  if (apk.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('未找到 EOCD'); process.exit(1); }
const oldEntryCount = apk.readUInt16LE(eocd + 10);
const oldCdSize = apk.readUInt32LE(eocd + 12);
const oldCdOffset = apk.readUInt32LE(eocd + 16);
const commentLen = apk.readUInt16LE(eocd + 20);
const comment = apk.subarray(eocd + 22, eocd + 22 + commentLen);

// 收集 assets 文件
const files = [];
function walk(dir, prefix) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel);
    else files.push({ rel, full });
  });
}
walk(ASSETS, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`收集 ${files.length} 个 assets 文件`);

// ── 构造新条目 ──
const newLocalParts = [];
const newCentralParts = [];
let localOffset = oldCdOffset; // 新条目接在现有数据之后

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const nameBuf = Buffer.from("assets/" + f.rel, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 6 });
  const crc = crc32(data);
  const mtime = fs.statSync(f.full).mtime;
  const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xFFFF;

  // 本地文件头
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);            // version needed
  lh.writeUInt16LE(0x0800, 6);        // UTF-8 flag
  lh.writeUInt16LE(8, 8);             // deflate
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);            // extra len
  newLocalParts.push(lh, nameBuf, comp);

  // 中央目录条目
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);            // version made by
  ch.writeUInt16LE(20, 6);            // version needed
  ch.writeUInt16LE(0x0800, 8);        // UTF-8 flag
  ch.writeUInt16LE(8, 10);            // deflate
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);            // extra len
  ch.writeUInt16LE(0, 32);            // comment len
  ch.writeUInt16LE(0, 34);            // disk start
  ch.writeUInt16LE(0, 36);            // internal attrs
  ch.writeUInt32LE(0, 38);            // external attrs
  ch.writeUInt32LE(localOffset, 42);  // local header offset
  newCentralParts.push(ch, nameBuf);

  localOffset += lh.length + nameBuf.length + comp.length;
}

// ── 重组 zip ──
const newCdSize = newCentralParts.reduce((n, p) => n + p.length, 0);
const newEntryCount = oldEntryCount + files.length;

// 新 EOCD
const ne = Buffer.alloc(22);
ne.writeUInt32LE(0x06054b50, 0);
ne.writeUInt16LE(0, 4);               // disk
ne.writeUInt16LE(0, 6);               // cd disk
ne.writeUInt16LE(newEntryCount, 8);   // entries this disk
ne.writeUInt16LE(newEntryCount, 10);  // entries total
ne.writeUInt32LE(newCdSize, 12);      // cd size
ne.writeUInt32LE(localOffset, 16);    // cd offset
ne.writeUInt16LE(commentLen, 20);     // comment len

const out = Buffer.concat([
  apk.subarray(0, oldCdOffset),       // 原始数据（本地文件头+数据）
  ...newLocalParts,                    // 新 assets 数据
  apk.subarray(oldCdOffset, eocd),    // 原中央目录
  ...newCentralParts,                  // 新中央目录
  ne,
  comment,
]);

fs.writeFileSync(APK, out);
console.log(`OK: ${files.length} 个 assets 已追加进 ${APK}（${(out.length/1024/1024).toFixed(1)} MB）`);
