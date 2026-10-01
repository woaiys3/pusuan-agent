#!/usr/bin/env node
/**
 * 发布**合并包** `pusuan` 到 woaiys3/pusuan-agent。
 *
 * 与 `create-plugins-release.mjs`（旧的三包合集）用的是同一套机制，
 * 共用 `tools/lib/github-release.mjs` —— 只有 tag / 产物 / 说明三处不同。
 *
 * 用法:
 *   node tools/create-pusuan-release.mjs --dry-run   # 只检查产物与认证，不做任何写操作
 *   node tools/create-pusuan-release.mjs             # 真正建 Release 并上传
 *
 * 幂等：Release 已存在则复用并同步说明；同名产物先删再传（可反复重跑）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, prepareRelease, publishRelease } from './lib/github-release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 合并包的 tag。升版时改这里（同时也要改下面 TITLE 里的版本号）。 */
const TAG = 'pusuan-v2.0.0';
const TITLE = '普算 · 合并包 v2.0.0（一个插件装齐）';
const DRY = process.argv.includes('--dry-run');

/** 要上传的产物。合并包只有一个 zip。 */
const ASSETS = [['pusuan.zip', 'C:/Users/Administrator/Desktop/pusuan.zip']];

const { token, prepared, body } = await prepareRelease(ASSETS, path.join(HERE, 'release-body-pusuan.md'));

// ⚠ dry-run 必须走 if/else 而不是 `if (DRY) process.exit(0)`：
//   ① 顶层 ESM 不能 return，靠“不写 else”会顺延执行真实发布；
//   ② Windows 上 process.exit() 会与未回收的句柄冲突，把退出码弄成 127。
if (DRY) {
	console.log('--dry-run：只检查，不创建、不上传');
	for (const a of prepared) console.log(`  ${a.name}  ${a.size} bytes`);
	console.log(`（若去掉 --dry-run，将发布到 ${REPO} 的 tag ${TAG}）`);
} else {
	await publishRelease(token, { tag: TAG, title: TITLE, body, assets: prepared });
}
