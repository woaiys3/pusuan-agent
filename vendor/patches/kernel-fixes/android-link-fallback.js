#!/usr/bin/env node
/**
 * Android 内核补丁：把 `node:fs/promises` 的 `link` 换成带回退的实现。
 *
 * 为什么必须改：
 *   内核有三处用硬链接做「同名不覆盖」的原子发布。Android 上 SELinux 在应用
 *   私有目录拒绝 link（真机/模拟器实测 `avc: denied { link }`，
 *   域 untrusted_app_27，permissive=0，Enforcing），且该域无法放开，
 *   文件系统是 ext4、link 本身可用 —— 只能换发布机制。
 *   症状：会话持久化失败 → turn/end 直接 error → 任何对话都有去无回。
 *
 * 改法：
 *   只把 `link` 这个**导入名**换成 wrapper：先试原生 link，仅当它以
 *   权限/不支持类错误码失败时，回退到同目录 rename（同文件系统，原子性相同）。
 *   因此：
 *     - 非 Android 平台行为逐字不变；
 *     - 其他错误码（EEXIST / ENOENT / EIO …）照原样抛出；
 *     - 各调用点代码一行不动，降到最小侵入。
 *
 * 三处调用点：
 *   dsh-session-persistence-jsonl  materializePosix  会话日志发布（阻塞项）
 *   dsh-fs-local                   writeFileAtomic   createIfAbsent 写文件
 *   dsh-attachment-local           commitPreparedImageFile  附件对象落盘
 *
 * 用法: node android-link-fallback.js <kernelDir>
 * 幂等：已打过则跳过；锚点缺失则报错退出（避免内核升级后静默漏补）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KERNEL = process.argv[2];
if (!KERNEL) {
  console.error('用法: node android-link-fallback.js <kernelDir>');
  process.exit(1);
}

// ── 注入的 wrapper（顶层语句，无缩进；内核源码用 tab 缩进）──
const WRAPPER = [
  '/* Android 适配（本仓库 vendor/patches/kernel-fixes 注入）：',
  '   应用私有目录上 SELinux 拒绝硬链接（avc denied { link }，Environ 域 untrusted_app',
  '   无法放开），而本包用 link 做「同名不覆盖」发布。仅当 link 因权限/不支持类错误码',
  '   失败时回退到同目录 rename（同文件系统，原子性相同）；其余平台与其余错误码逐字不变。 */',
  'const __ANDROID_LINK_FALLBACK_CODES = /* @__PURE__ */ new Set([',
  '\t"EACCES",',
  '\t"EPERM",',
  '\t"ENOTSUP",',
  '\t"EOPNOTSUPP"',
  ']);',
  'const link = async (source, destination) => {',
  '\ttry {',
  '\t\treturn await __nativeLink(source, destination);',
  '\t} catch (error) {',
  '\t\tconst code = error === null || error === void 0 ? void 0 : error.code;',
  '\t\tif (!__ANDROID_LINK_FALLBACK_CODES.has(code)) throw error;',
  '\t\treturn await rename(source, destination);',
  '\t}',
  '};',
  '',
].join('\n');

const PATCHES = [
  {
    file: 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    // 导入名让位给 wrapper；rename 原本没导入，补上
    from: 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
    to: 'import { link as __nativeLink, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";',
  },
  {
    file: 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js',
    from: 'import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";',
    to: 'import { chmod, link as __nativeLink, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";',
  },
  {
    file: 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js',
    from: 'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
    to: 'import { chmod, link as __nativeLink, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
  },
];

// attachment-local 发布成功后 staging 文件已随 rename 移走，成功后那句 unlink 会 ENOENT；
// 原代码把外层任何异常都包成 ATTACHMENT_WRITE_FAILED，所以这里必须容忍 ENOENT。
const ATTACHMENT_UNLINK = {
  file: 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js',
  from: '\t\tawait unlink(temporary);\n\t} catch (error) {',
  to:
    '\t\tawait unlink(temporary).catch(\n' +
    '\t\t\t/* Android 回退走 rename 发布时 staging 文件已随发布移走，此处 ENOENT 属正常 */\n' +
    '\t\t\t(cleanupError) => {\n' +
    '\t\t\t\tif (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;\n' +
    '\t\t\t}\n' +
    '\t\t);\n\t} catch (error) {',
};

const MARK = '__ANDROID_LINK_FALLBACK_CODES';

function edit(rel, from, to) {
  const abs = path.join(KERNEL, rel);
  if (!fs.existsSync(abs)) throw new Error('缺少文件：' + rel);
  const source = fs.readFileSync(abs, 'utf8');
  if (source.includes(from)) {
    fs.writeFileSync(abs, source.replace(from, to));
    return 'applied';
  }
  if (source.includes(to)) return 'already';
  throw new Error('锚点未命中，内核可能已升级：' + rel + '\n  期望：' + from);
}

console.log('  Android link 回退补丁：');
for (const p of PATCHES) {
  // 导入改名 + wrapper 注入（一次替换完成，避免 import 语句与 wrapper 错位）
  const abs = path.join(KERNEL, p.file);
  if (!fs.existsSync(abs)) throw new Error('缺少文件：' + p.file);
  let source = fs.readFileSync(abs, 'utf8');
  if (source.includes(MARK)) {
    console.log('    ' + p.file + '（已应用，跳过）');
    continue;
  }
  if (!source.includes(p.from)) {
    throw new Error('锚点未命中，内核可能已升级：' + p.file + '\n  期望：' + p.from);
  }
  source = source.replace(p.from, (match) =>
    match === p.to ? match : p.to + '\n' + WRAPPER
  );
  fs.writeFileSync(abs, source);
  console.log('    ' + p.file);
}

console.log('    ' + ATTACHMENT_UNLINK.file + '（staging ENOENT 容忍）　' + edit(ATTACHMENT_UNLINK.file, ATTACHMENT_UNLINK.from, ATTACHMENT_UNLINK.to));
console.log('  补丁完成');
