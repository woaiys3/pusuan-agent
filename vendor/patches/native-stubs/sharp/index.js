/**
 * sharp 的 Android 桩。
 *
 * 为什么需要：sharp 依赖 libvips 原生库，官方与 termux 均无 Android(bionic) 产物。
 * 内核的 dsh-attachment-local 在模块顶层静态 import 了它，
 * 加载失败会让 attachment-local 插件整体不可用，进而拖垮插件树。
 *
 * 为什么桩掉而不是替代实现：attachment-local 用 sharp 做的是**完整图像处理**——
 * 探测元数据、全量解码、旋转/色彩空间转换、缩放、重编码、颜色数统计。
 * 纯 JS 等价实现相当于自带一个 JPEG/PNG/WebP 编解码器，不属于本阶段范围。
 *
 * 后果（明确记录，不假装支持）：附件图片功能不可用；
 * 文字对话、六壬/六爻/塔罗/小六壬工具、知识库、技能全部正常。
 *
 * 行为：本桩在**被调用时**抛出带原因的错误，让限制立刻可见，
 * 而不是静默返回假图像数据。
 */

const REASON =
  '图片附件在 Android 上暂不可用：sharp 依赖 libvips 原生库，' +
  'Android(bionic) 无可用产物。文字对话与占卜功能不受影响';

function unsupported(op) {
  throw new Error(`${REASON}（试图调用 sharp${op ? '.' + op : ''}）`);
}

/** sharp(data, opts) 返回处理管线；本桩在构造时即拒绝。 */
function sharp() {
  unsupported('');
}

// attachment-local 可能触碰的静态属性
sharp.cache = () => unsupported('cache');
sharp.concurrency = () => unsupported('concurrency');
sharp.simd = () => unsupported('simd');
sharp.versions = { stub: 'android' };
sharp.format = {};

export default sharp;
export { sharp };
