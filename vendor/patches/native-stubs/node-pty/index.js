/**
 * node-pty 的 Android 桩。
 *
 * 为什么需要：node-pty 的原生产物只有 linux/darwin/win32 的预编译（无 bionic 版本）。
 * 内核的 dsh-subprocess-local 在**模块顶层**静态 import 了它，
 * 加载失败就会让整个 subprocess 插件不可用 —— 而会话管理依赖该插件。
 *
 * 为什么可以桩掉：内核里 `nodePty.spawn()` 只在 `spawnTerminal()`
 * （开交互式终端）里调用一次。普算的手机界面不使用终端，
 * 所以真实调用路径不会被执行。
 *
 * 行为：被真正调用时抛出明确错误，不静默返回假对象 —— 将来若某条路径真要用终端，
 * 必须让问题立刻可见。
 */

const REASON =
  'node-pty 在 Android 上不可用：官方未提供 bionic 预编译产物。' +
  '普算手机端不使用交互式终端，如需该能力需自行交叉编译 node-pty';

export function spawn() {
  throw new Error(`${REASON}（试图调用 node-pty.spawn）`);
}

export function open() {
  throw new Error(`${REASON}（试图调用 node-pty.open）`);
}

export default { spawn, open };
