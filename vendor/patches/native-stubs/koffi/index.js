/**
 * koffi 的 Android 桩。
 *
 * 为什么需要：koffi 是原生 FFI 绑定，其预编译产物只有 win32-x64，
 * Android(bionic) 上无法加载 —— 缺了它，内核会以
 * "Cannot find the native Koffi module" 直接拒绝加载依赖它的插件，
 * 整个插件树起不来。
 *
 * 为什么可以桩掉而不是实现：内核里 koffi 的每一个 **实际调用点** 都在
 * Windows 分支内（load("kernel32.dll")、advapi32、user32 等），
 * 在 Android 上永远不会执行。模块顶层只用到类型注册（如
 * `const PVOID = koffi.pointer("void")`），不触及原生库。
 *
 * 因此本桩分两类行为：
 *   - 类型注册类（pointer/struct/proto/array/type）：返回惰性占位符，让模块能加载；
 *   - 真正触达原生库的（load/alloc/encode/decode/address/register）：立刻抛出
 *     带原因的错误，而不是静默返回错误结果——万一将来有非 Windows 路径用到，
 *     必须让问题立刻暴露，不能悄悄算错。
 */

const REASON =
  'koffi 在 Android 上不可用：这是 Windows-only 的 FFI 绑定，' +
  '内核中所有调用点都位于 win32 分支，Android 上不应被执行';

function refuse(op) {
  throw new Error(`${REASON}（试图调用 koffi.${op}）`);
}

/** 类型注册返回的占位符：只被当作不透明句柄在模块作用域传递。 */
function placeholder(name) {
  return Object.freeze({ __koffiStub: true, name: String(name ?? '') });
}

const api = {
  // ── 类型/签名注册：模块顶层会用到，必须成功返回 ──
  pointer: (name) => placeholder(`ptr<${name}>`),
  struct: (name) => placeholder(`struct<${name}>`),
  proto: (sig) => placeholder(`proto<${String(sig).slice(0, 40)}>`),
  array: (name) => placeholder(`array<${name}>`),
  type: (name) => placeholder(`type<${name}>`),
  resolve: (name) => placeholder(`resolve<${name}>`),

  // ── 触达原生库：一律明确拒绝 ──
  load: () => refuse('load'),
  alloc: () => refuse('alloc'),
  encode: () => refuse('encode'),
  decode: () => refuse('decode'),
  address: () => refuse('address'),
  register: () => refuse('register'),
  unregister: () => refuse('unregister'),
  func: () => refuse('func'),
  introspect: () => refuse('introspect'),
  node: () => refuse('node'),
};

export default api;
export const { pointer, struct, proto, array, type, resolve, load, alloc, encode, decode } = api;
