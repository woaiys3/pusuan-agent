#!/usr/bin/env node
/**
 * 校验装配好的 Android 运行时能否自洽：解析 ELF 的动态依赖（DT_NEEDED）闭包。
 *
 * 为什么需要它：node 是动态链接的，任何一个 DT_NEEDED 在设备上找不到，
 * 进程就直接起不来，且报错只会在设备端出现。本机没有 readelf/objdump，
 * 所以这里按 ELF 规范直接读节表，把缺库问题提前暴露在构建阶段。
 *
 * 用法: node tools/verify-runtime.js [abiDir ...]
 * 默认校验 vendor/runtime 下的所有 ABI。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Android/bionic 由系统提供的库：不需要随 APK 分发。
// 注意 libc++_shared.so 不在其中 —— Termux 的 node 链的是它，必须自带。
const SYSTEM_LIBS = new Set([
  'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so',
  'libstdc++.so', 'libz.so', 'libc++_shared.so.tmp', 'libGLESv2.so',
  'libEGL.so', 'libjnigraphics.so', 'libOpenSLES.so',
]);

function parseElfNeeded(buf, label) {
  if (buf.length < 64 || buf.readUInt32LE(0) !== 0x464c457f) return { err: 'not ELF' };
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  if (!is64 || !le) return { err: 'unsupported ELF class/endianness' };

  const machine = buf.readUInt16LE(0x12);           // e_machine: 0xB7=aarch64, 0x3E=x86_64
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);

  const need = [];
  let dynstr = null, dyn = null;

  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (o + 64 > buf.length) break;
    const type = buf.readUInt32LE(o + 4);
    const off = Number(buf.readBigUInt64LE(o + 0x18));
    const size = Number(buf.readBigUInt64LE(o + 0x20));
    const link = buf.readUInt32LE(o + 0x28);
    if (type === 6) dyn = { off, size, link };                 // SHT_DYNAMIC
  }
  if (!dyn) return { machine, need };

  // dynstr 是 .dynamic 的 sh_link 指向的节
  const so = shoff + dyn.link * shentsize;
  dynstr = { off: Number(buf.readBigUInt64LE(so + 0x18)), size: Number(buf.readBigUInt64LE(so + 0x20)) };

  const strAt = (idx) => {
    const s = dynstr.off + idx;
    let e = s;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(s, e).toString('latin1');
  };

  for (let p = dyn.off; p + 16 <= dyn.off + dyn.size; p += 16) {
    const tag = Number(buf.readBigUInt64LE(p));
    const val = Number(buf.readBigUInt64LE(p + 8));
    if (tag === 0) break;                                       // DT_NULL
    if (tag === 1) need.push(strAt(val));                       // DT_NEEDED
  }
  return { machine, need };
}

const ABI_MACHINE = { 'arm64-v8a': 0xb7, 'x86_64': 0x3e };

function verifyAbi(root, abi) {
  const dir = path.join(root, abi);
  const nodePath = path.join(dir, 'bin', 'node');
  const libDir = path.join(dir, 'lib');
  const problems = [];
  const notes = [];

  if (!fs.existsSync(nodePath)) return { abi, problems: [`缺少 ${nodePath}`], notes };

  const available = new Set(fs.readdirSync(libDir));
  const wantMachine = ABI_MACHINE[abi];

  // 1) 架构一致性 + node 自身依赖
  const nodeBuf = fs.readFileSync(nodePath);
  const nodeElf = parseElfNeeded(nodeBuf, 'node');
  if (nodeElf.machine !== wantMachine) {
    problems.push(`bin/node 架构不符：e_machine=0x${nodeElf.machine.toString(16)}，期望 0x${wantMachine.toString(16)}`);
  }

  // 2) 递归解析依赖闭包：node → .so → .so ...
  const seen = new Set();
  const queue = [...nodeElf.need];
  const resolved = new Map();

  while (queue.length) {
    const so = queue.shift();
    if (seen.has(so)) continue;
    seen.add(so);

    if (available.has(so)) {
      const p = path.join(libDir, so);
      const b = fs.readFileSync(p);
      const elf = parseElfNeeded(b, so);
      resolved.set(so, 'lib');
      if (so.endsWith('.so') || so.includes('.so.')) {
        if (elf.machine !== undefined && elf.machine !== wantMachine) {
          problems.push(`${so} 架构不符：e_machine=0x${elf.machine.toString(16)}，期望 0x${wantMachine.toString(16)}`);
        }
        for (const n of elf.need) queue.push(n);
      }
    } else if (SYSTEM_LIBS.has(so)) {
      resolved.set(so, 'system');
    } else {
      resolved.set(so, 'MISSING');
    }
  }

  const missing = [...resolved.entries()].filter(([, v]) => v === 'MISSING').map(([k]) => k);
  if (missing.length) problems.push(`缺失动态库：${missing.join(', ')}`);

  // 3) 报告 node 的直接依赖，便于人工核对
  notes.push(`node 直接依赖 ${nodeElf.need.length} 个：${nodeElf.need.join(', ')}`);
  const fromLib = [...resolved.entries()].filter(([, v]) => v === 'lib').map(([k]) => k);
  const fromSys = [...resolved.entries()].filter(([, v]) => v === 'system').map(([k]) => k);
  notes.push(`lib/ 提供 ${fromLib.length} 个，系统提供 ${fromSys.length} 个${fromSys.length ? '（' + fromSys.join(', ') + '）' : ''}`);

  // 4) 未被任何依赖引用的 so（体积浪费，仅提示）
  const unused = [...available].filter(f => !resolved.has(f));
  if (unused.length) notes.push(`未被引用（可考虑裁掉）：${unused.join(', ')}`);

  return { abi, problems, notes };
}

const root = process.argv[2] || path.join(__dirname, '..', 'vendor', 'runtime');
let abis = process.argv.slice(3);
if (!abis.length) {
  abis = fs.readdirSync(root).filter(f => fs.statSync(path.join(root, f)).isDirectory());
}

let failed = 0;
for (const abi of abis) {
  const r = verifyAbi(root, abi);
  console.log(`─── ${abi} ───`);
  for (const n of r.notes) console.log('   ' + n);
  if (r.problems.length) {
    failed++;
    for (const p of r.problems) console.log('   ✗ ' + p);
  } else {
    console.log('   ✓ 依赖闭包完整');
  }
  console.log();
}

if (failed) { console.log(`校验失败：${failed} 个 ABI 有问题`); process.exit(1); }
console.log('运行时校验通过');
