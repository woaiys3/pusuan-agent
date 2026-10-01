//#region github release helper
/**
 * GitHub Release 的共用机制：取凭据、调 REST、建/复用 Release、传产物。
 *
 * 为什么不走 MCP 的 GitHub 工具：那套工具只有 issue / PR / 文件 / 提交，
 * **没有 Release 能力**，所以这里直连 REST API。
 *
 * 为什么不读环境变量里的 token：本机凭据由系统 `credential.helper=manager` 托管。
 * 这里用 `git credential fill` **现取现用**，token 只在进程内存在，
 * **不落盘、不回显**（只报长度，从不打印内容）。
 *
 * 本模块由两个发布脚本共用：
 *   - `tools/create-plugins-release.mjs`（旧的三包合集）
 *   - `tools/create-pusuan-release.mjs`（合并包）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** 目标仓库。 */
export const REPO = 'woaiys3/pusuan-agent';

/**
 * 从本机 git 凭据助手取 token。**调用方不得打印返回值。**
 * @returns {string} token。
 */
export function readToken() {
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
export async function api(pathname, init = {}, token) {
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
 * 读取产物。缺一个就报错（宁可不发，也不发残缺的 Release）。
 * @param {[string,string][]} pairs - `[上传名, 本地路径]` 列表。
 * @returns {{name:string, file:string, buf:Buffer, size:number}[]} 已就位的产物。
 */
export function prepareAssets(pairs) {
	const prepared = [];
	for (const [name, file] of pairs) {
		if (!fs.existsSync(file)) throw new Error(`缺少产物：${file}`);
		const buf = fs.readFileSync(file);
		prepared.push({ name, file, buf, size: buf.length });
	}
	return prepared;
}

/**
 * 建 Release 并上传全部产物（幂等）。
 *
 * 已存在则复用，并**同步说明正文** —— 否则改了说明文件却不上远端，
 * 页面里还是旧文案（第一版就漏了这步，已修）。
 * 同名产物先删再传，可反复重跑。
 *
 * @param {string} token - GitHub 凭据。
 * @param {{tag:string, title:string, body:string, assets:{name:string,buf:Buffer,size:number}[]}} spec - 发布内容。
 * @returns {Promise<{id:number, html_url:string, tag_name:string}>} 发布结果。
 */
export async function publishRelease(token, spec) {
	const { tag, title, body, assets } = spec;
	let rel = (await api(`/repos/${REPO}/releases/tags/${tag}`, {}, token)).json;
	if (rel?.id) {
		const patched = await api(
			`/repos/${REPO}/releases/${rel.id}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ name: title, body }),
				headers: { 'Content-Type': 'application/json' },
			},
			token
		);
		if (patched.status !== 200) throw new Error(`更新 Release 说明失败：HTTP ${patched.status}`);
		rel = patched.json;
		console.log(`Release 已存在（id=${rel.id}），已同步说明正文，复用并补传产物`);
	} else {
		const created = await api(
			`/repos/${REPO}/releases`,
			{
				method: 'POST',
				body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: false }),
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
	for (const a of assets) {
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
	const list = verify.json?.assets ?? [];
	console.log(`\n=== 核验：Release ${verify.json?.tag_name} 共 ${list.length} 个产物 ===`);
	for (const a of list) console.log(`  ${a.name.padEnd(30)} ${String(a.size).padStart(10)} bytes  ${a.state}`);
	console.log(`\n${verify.json?.html_url}`);
	return verify.json;
}

/**
 * 认证 + 产物就位 + 说明读取，发布前的公共准备。
 * @param {[string,string][]} assetPairs - 产物 `[上传名, 路径]`。
 * @param {string} bodyFile - 发行说明文件路径。
 * @returns {Promise<{token:string, prepared:object[], body:string}>} 就绪的三样。
 */
export async function prepareRelease(assetPairs, bodyFile) {
	const token = readToken();
	console.log(`凭据已取到（${token.length} 字符，内容不显示）`);

	const me = await api('/user', {}, token);
	if (me.status !== 200) throw new Error(`认证失败：HTTP ${me.status}`);
	console.log(`认证通过：${me.json.login}`);

	const prepared = prepareAssets(assetPairs);
	console.log(
		`产物齐备：${prepared.length} 个，合计 ${(prepared.reduce((s, a) => s + a.size, 0) / 1048576).toFixed(1)} MB`
	);

	return { token, prepared, body: fs.readFileSync(bodyFile, 'utf8') };
}
//#endregion
