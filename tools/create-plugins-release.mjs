#!/usr/bin/env node
/**
 * 在 woaiys3/pusuan-agent 上创建 Release 并上传插件产物。
 *
 * 为什么不走 MCP 的 GitHub 工具：那套工具只有 issue / PR / 文件 / 提交，
 * **没有 Release 能力**，所以这里直连 REST API。
 *
 * 为什么不读环境变量里的 token：本机凭据由系统 `credential.helper=manager` 托管。
 * 这里用 `git credential fill` **现取现用**，token 只在进程内存在，
 * **不落盘、不回显**（本脚本只报长度，从不打印内容）。
 *
 * 用法:
 *   node tools/create-plugins-release.mjs --dry-run   # 只检查产物与认证，不做任何写操作
 *   node tools/create-plugins-release.mjs             # 真正建 Release 并上传
 *
 * 幂等：Release 已存在则复用；同名产物先删再传（可反复重跑）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'woaiys3/pusuan-agent';
const TAG = 'pusuan-plugins-v1.0.1';
const TITLE = '普算插件合集 v1.0.1（DSH 0.1.7）';
const DRY = process.argv.includes('--dry-run');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DESKTOP = 'C:/Users/Administrator/Desktop';
const ARCHIVE = `${DESKTOP}/_旧交付_归档`;

/** 要上传的产物。顺序即 Release 里的展示顺序。 */
const ASSETS = [
	['pusuan-skills.zip', `${ARCHIVE}/pusuan-skills.zip`],
	['pusuan-persona.zip', `${DESKTOP}/pusuan-persona.zip`],
	['dsh-plugin-mobile-adapt.zip', `${ARCHIVE}/dsh-plugin-mobile-adapt.zip`],
	['pusuan-knowledge.zip', `${DESKTOP}/pusuan-knowledge.zip`],
	['pusuan-divination.zip', `${DESKTOP}/pusuan-divination.zip`],
];

/**
 * 从本机 git 凭据助手取 token。**调用方不得打印返回值。**
 * @returns {string} token。
 */
function readToken() {
	const out = execFileSync('git', ['credential', 'fill'], {
		input: 'protocol=https\nhost=github.com\n\n',
		encoding: 'utf8',
	});
	const line = out.split('\n').find((l) => l.startsWith('password='));
	if (!line) throw new Error('取不到 GitHub 凭据（credential.helper 未提供 password）');
	return line.slice('password='.length);
}

/**
 * 调 api.github.com。
 * @param {string} pathname - 以 / 开头的 API 路径。
 * @param {RequestInit} [init] - 额外请求参数。
 * @param {string} [token] - 本次请求的凭据。
 * @returns {Promise<{status:number, json:object|null}>} 状态与解析后的 JSON。
 */
async function api(pathname, init = {}, token) {
	const res = await fetch(`https://api.github.com${pathname}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'pusuan-release-script',
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON 响应（如网关错误页）保留原样，不抛 */
	}
	return { status: res.status, json };
}

/**
 * 建 Release 并上传全部产物。
 * @param {string} token - GitHub 凭据。
 * @param {{name:string, file:string, buf:Buffer, size:number}[]} prepared - 已就位的产物。
 * @param {string} body - Release 说明（Markdown）。
 */
async function publish(token, prepared, body) {
	let rel = (await api(`/repos/${REPO}/releases/tags/${TAG}`, {}, token)).json;
	if (rel?.id) {
		console.log(`Release 已存在（id=${rel.id}），复用并补传缺失产物`);
	} else {
		const created = await api(
			`/repos/${REPO}/releases`,
			{
				method: 'POST',
				body: JSON.stringify({ tag_name: TAG, name: TITLE, body, draft: false, prerelease: false }),
				headers: { 'Content-Type': 'application/json' },
			},
			token
		);
		if (created.status !== 201) {
			throw new Error(`建 Release 失败：HTTP ${created.status} ${JSON.stringify(created.json)?.slice(0, 300)}`);
		}
		rel = created.json;
		console.log(`✅ Release 已创建：${rel.html_url}`);
	}

	const existing = (await api(`/repos/${REPO}/releases/${rel.id}/assets`, {}, token)).json ?? [];
	for (const a of prepared) {
		const dup = existing.find((e) => e.name === a.name);
		if (dup) {
			const del = await api(`/repos/${REPO}/releases/assets/${dup.id}`, { method: 'DELETE' }, token);
			if (del.status !== 204 && del.status !== 200) throw new Error(`删旧产物失败：${a.name} HTTP ${del.status}`);
			console.log(`  （替换已有的 ${a.name}）`);
		}

		const res = await fetch(
			`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(a.name)}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/zip',
					'Content-Length': String(a.size),
					'User-Agent': 'pusuan-release-script',
				},
				body: a.buf,
			}
		);
		if (res.status !== 201) {
			const t = await res.text();
			throw new Error(`上传失败：${a.name} HTTP ${res.status} ${t.slice(0, 200)}`);
		}
		const j = await res.json();
		console.log(`  ✅ ${a.name}  ${(j.size / 1024).toFixed(0)} KB`);
	}

	const verify = await api(`/repos/${REPO}/releases/${rel.id}`, {}, token);
	const assets = verify.json?.assets ?? [];
	console.log(`\n=== 核验：Release ${verify.json?.tag_name} 共 ${assets.length} 个产物 ===`);
	for (const a of assets) console.log(`  ${a.name.padEnd(30)} ${String(a.size).padStart(10)} bytes  ${a.state}`);
	console.log(`\n${verify.json?.html_url}`);
}

// ── 准备：取凭据、查产物、读说明 ────────────────────────────────
const TOKEN = readToken();
console.log(`凭据已取到（${TOKEN.length} 字符，内容不显示）`);

const me = await api('/user', {}, TOKEN);
if (me.status !== 200) throw new Error(`认证失败：HTTP ${me.status}`);
console.log(`认证通过：${me.json.login}`);

const prepared = [];
for (const [name, file] of ASSETS) {
	if (!fs.existsSync(file)) throw new Error(`缺少产物：${file}`);
	const buf = fs.readFileSync(file);
	prepared.push({ name, file, buf, size: buf.length });
}
console.log(`产物齐备：${prepared.length} 个，合计 ${(prepared.reduce((s, a) => s + a.size, 0) / 1048576).toFixed(1)} MB`);

const body = fs.readFileSync(path.join(HERE, 'release-body-plugins.md'), 'utf8');

// ── 分岔：dry-run 到此为止 ─────────────────────────────────────
//
// ⚠ 这里必须用 if/else 结构而不是「if (DRY) { …; process.exit(0) }」：
//   ① 顶层 ESM 不能 return，靠“不写 else”会顺延执行真实流程
//      —— 本脚本第一版就因此让 `--dry-run` 真的建了 Release（已修）；
//   ② Windows 上 process.exit() 会与 git 子进程未回收的句柄冲突，
//      触发 libuv 断言并把退出码弄成 127。
//   所以：dry-run 分支不调用 publish()，脚本自然结束。
if (DRY) {
	console.log('--dry-run：只检查，不创建、不上传');
	for (const a of prepared) console.log(`  ${a.name}  ${a.size} bytes`);
	console.log(`（若去掉 --dry-run，将发布到 ${REPO} 的 tag ${TAG}）`);
} else {
	await publish(TOKEN, prepared, body);
}
