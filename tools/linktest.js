// 在设备上验证硬链接能力：内核会话持久化用 fs.link 做原子发布
import { link, writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'linkprobe');
const tmp = join(dir, 'a.tmp');
const fin = join(dir, 'a.final');

try {
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, 'hello');
  await link(tmp, fin);
  const back = await readFile(fin, 'utf8');
  console.log('link 成功，读回:', back);
  await unlink(tmp);
  await unlink(fin);
} catch (e) {
  console.log('link 失败:', e.code, '-', e.message);
}

// 顺带确认 rename（另一条原子发布路径）是否可用
const t2 = join(dir, 'b.tmp');
const f2 = join(dir, 'b.final');
try {
  await writeFile(t2, 'world');
  const { rename } = await import('node:fs/promises');
  await rename(t2, f2);
  console.log('rename 成功');
  await unlink(f2);
} catch (e) {
  console.log('rename 失败:', e.code, '-', e.message);
}
