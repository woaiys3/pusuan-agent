#!/usr/bin/env node
/**
 * 发布**旧的三包合集** 到 woaiys3/pusuan-agent。
 *
 * ⚠ 这是**历史发行**（`pusuan-plugins-v1.0.1`）。当前交付已改为**合并包** `pusuan` 2.0.0，
 * 见 `create-pusuan-release.mjs`。本脚本保留是为了那份发行仍可复现/回滚；
 * 正常情况下**不要**再往这个 tag 上传（会与合并包重复）。
 *
 * 机制共用 `tools/lib/github-release.mjs`。
 *
 * 用法:
 *   node tools/create-plugins-release.mjs --dry-run   # 只检查产物与认证，不做任何写操作
 *   node tools/create-plugins-release.mjs             # 真正建 Release 并上传
 *
 * 幂等：Release 已存在则复用并同步说明；同名产物先删再传（可反复重跑）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, prepareRelease, publishRelease } from './lib/github-release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TAG = 'pusuan-plugins-v1.0.1';
const TITLE = '普算插件合集 v1.0.1（DSH 0.1.7）';
const DRY = process.argv.includes('--dry-run');

const DESKTOP = 'C:/Users/Administrator/Desktop';
const ARCHIVE = `${DESKTOP}/_旧交付_归档`;
// 合并包的发布把三个包挪进了这里，路径跟着改（不然本脚本会报「缺少产物」）
const OLD3 = `${ARCHIVE}/三包版-1.0.1-1.1.0`;

/** 要上传的产物。顺序即 Release 里的展示顺序。 */
const ASSETS = [
	['pusuan-skills.zip', `${ARCHIVE}/pusuan-skills.zip`],
	['pusuan-persona.zip', `${OLD3}/pusuan-persona.zip`],
	['dsh-plugin-mobile-adapt.zip', `${ARCHIVE}/dsh-plugin-mobile-adapt.zip`],
	['pusuan-knowledge.zip', `${OLD3}/pusuan-knowledge.zip`],
	['pusuan-divination.zip', `${OLD3}/pusuan-divination.zip`],
];

const { token, prepared, body } = await prepareRelease(ASSETS, path.join(HERE, 'release-body-plugins.md'));

// ⚠ dry-run 必须走 if/else 而不是 `if (DRY) process.exit(0)`：
//   ① 顶层 ESM 不能 return，靠“不写 else”会顺延执行真实发布
//      —— 本脚本第一版就因此让 `--dry-run` 真的建了 Release（已修）；
//   ② Windows 上 process.exit() 会与未回收的句柄冲突，把退出码弄成 127。
if (DRY) {
	console.log('--dry-run：只检查，不创建、不上传');
	for (const a of prepared) console.log(`  ${a.name}  ${a.size} bytes`);
	console.log(`（若去掉 --dry-run，将发布到 ${REPO} 的 tag ${TAG}）`);
} else {
	await publishRelease(token, { tag: TAG, title: TITLE, body, assets: prepared });
}
