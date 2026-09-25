#!/usr/bin/env node
/**
 * 解 Termux .deb（ar 归档 → data.tar.xz → 释放文件）
 * 用法: node debunpack.js <deb> <outDir>
 * 只做必要的事：解析 ar 头，挑出 data.tar.*，再交给 tar 外部命令解压。
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const [deb, outDir] = process.argv.slice(2);
if (!deb || !outDir) { console.error('用法: node debunpack.js <deb> <outDir>'); process.exit(1); }

const buf = fs.readFileSync(deb);
if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') { console.error('不是 ar 归档'); process.exit(1); }

let off = 8;
const members = [];
while (off + 60 <= buf.length) {
  const name = buf.subarray(off, off + 16).toString('latin1').trim();
  const size = parseInt(buf.subarray(off + 48, off + 58).toString('latin1').trim(), 10);
  if (!Number.isFinite(size)) break;
  const dataStart = off + 60;
  members.push({ name: name.replace(/\/$/, ''), dataStart, size });
  off = dataStart + size + (size % 2);        // ar 成员 2 字节对齐
}

const data = members.find(m => m.name.startsWith('data.tar'));
if (!data) { console.error('未找到 data.tar 成员；含:', members.map(m => m.name).join(', ')); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, '__data.tar');
const ext = data.name.split('.').pop();      // xz / gz / zst
fs.writeFileSync(tmp, buf.subarray(data.dataStart, data.dataStart + data.size));
console.log(`成员 ${data.name} (${(data.size/1048576).toFixed(2)}MB) → 解压中`);

// 解压 data.tar.xz → 用 tar（能一步处理 xz + tar）。
// 要点：先在进程里 chdir 到目标目录，再传相对文件名。
// 不传 execFileSync 的 cwd：Git Bash 的 MSYS tar 收到 Windows 路径 cwd 时会参数解析失败（exit 2）。
const prevCwd = process.cwd();
process.chdir(outDir);
try {
  execFileSync('tar', ['-xf', '__data.tar'], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (e) {
  // Windows 非特权进程建不了符号链接，deb 内 doc/LICENSE 的链接会让 tar 以非零码退出。
  // 我们只取普通文件（node 可执行文件、.so），所以这类失败只警告、不中止。
  const err = (e.stderr || '').toString();
  if (/cannot create symlink/i.test(err)) {
    console.log('  注意：部分符号链接未创建（Windows 限制），普通文件已解出，继续');
  } else {
    throw e;
  }
} finally {
  process.chdir(prevCwd);
}
fs.unlinkSync(tmp);
console.log('完成 →', outDir);
