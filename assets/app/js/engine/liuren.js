/**
 * 普算移动端 · 六壬排盘封装
 * 对应桌面版 liuren_paipan/liuren_quickjs.py（方案 A）。
 * 原版引擎 lrpp.js / nongli.js / tys_20230527.js 已在 WebView 中以 <script> 预载，
 * 本文件提供 intent 解析（_resolve_intent）与排盘调用（paipan），
 * 输出过滤（OMIT_FIELDS / FIELD_TRANSFORMS）与原版一致。
 */
(function (global) {
  'use strict';

  var _ZHI = '子丑寅卯辰巳午未申酉戌亥';
  var _TG = '甲乙丙丁戊己庚辛壬癸';
  var _DZ = '子丑寅卯辰巳午未申酉戌亥';

  // 输出裁剪（对应 Python OMIT_FIELDS）
  var OMIT_FIELDS = ['SP_ZS', 'jiyingqian'];
  var FIELD_TRANSFORMS = {
    zhizhi: function (text) {
      if (typeof text !== 'string') return text;
      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('课体：') === 0) return lines[i];
      }
      return text;
    },
  };

  function applyOutputFilters(result) {
    OMIT_FIELDS.forEach(function (k) { delete result[k]; });
    Object.keys(FIELD_TRANSFORMS).forEach(function (k) {
      if (k in result) result[k] = FIELD_TRANSFORMS[k](result[k]);
    });
    return result;
  }

  function paipan(params) {
    // setup 由 lrpp.js 提供（已预载到全局）
    if (typeof setup !== 'function') {
      throw new Error('六壬引擎未加载（lrpp.js 缺失）');
    }
    var result = setup(params).result;
    return applyOutputFilters(JSON.parse(JSON.stringify(result)));
  }

  // ── 报数换算（对应 Python baoshu_to_h24 / _js_number） ──
  function jsNumber(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var s = v.trim();
      if (s === '') return 0;
      var n = Number(s);
      if (isNaN(n)) throw new Error('报数无法解析为数字: ' + v);
      return n;
    }
    throw new Error('报数无法解析为数字: ' + v);
  }

  function baoshuToH24(n) {
    var v;
    if (typeof n === 'string' && _ZHI.indexOf(n.trim()) >= 0) {
      v = _ZHI.indexOf(n.trim()) + 1;
    } else {
      v = jsNumber(n);
      if (!isFinite(v)) throw new Error('报数无法解析为数字: ' + n);
      v = Math.trunc(v);
    }
    if (v === 0) v = -1;
    v = Math.abs(v);
    var idx = v % 12;
    if (idx === 0) idx = 12;
    return [_ZHI[idx - 1], (idx - 1) * 2];
  }

  // 农历转公历（nongli.js 已预载）
  function nlToGl(y, m, d) {
    if (typeof nl_to_gl === 'function') return nl_to_gl(y, m, d);
    throw new Error('农历转换引擎未加载（nongli.js 缺失）');
  }

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function isDate(dt) { return dt && isInt(dt.y) && isInt(dt.m) && isInt(dt.d); }
  function isGreg(dt, needI) {
    if (!dt || typeof dt !== 'object') return false;
    if (!(isInt(dt.y) && isInt(dt.m) && isInt(dt.d) && isInt(dt.h))) return false;
    if (needI) return isInt(dt.i);
    return dt.i === undefined || dt.i === null || isInt(dt.i);
  }

  function checkSizhuDt(dt) {
    if (!dt || typeof dt !== 'object') return false;
    var pairs = [dt.y, dt.d];
    for (var i = 0; i < pairs.length; i++) {
      var f = pairs[i];
      if (typeof f !== 'string' || f.length !== 2) return false;
      if (_TG.indexOf(f[0]) < 0 || _DZ.indexOf(f[1]) < 0) return false;
      if ((_TG.indexOf(f[0]) - _DZ.indexOf(f[1])) % 2 !== 0) return false;
    }
    var singles = [dt.m, dt.h];
    for (var j = 0; j < singles.length; j++) {
      if (typeof singles[j] !== 'string' || _DZ.indexOf(singles[j]) < 0) return false;
    }
    return true;
  }

  function buildParams(opts) {
    opts = opts || {};
    var zhs = opts.zhs || '正时';
    var params = {
      zhs: zhs,
      grxz: opts.grxz || '甲戊庚牛羊',
      zygr: opts.zygr || '自动选择',
      sex: opts.sex || '男',
      age: opts.age !== undefined ? opts.age : 18,
      glzxyj: opts.glzxyj || '中气换将',
      shehai: opts.shehai || '孟仲季',
    };

    if (zhs === '四柱') {
      if (!opts.dt || !('y' in opts.dt) || !('m' in opts.dt) || !('d' in opts.dt) || !('h' in opts.dt)) {
        throw new Error("四柱模式 dt 须为干支串 {y:'甲子', m:'戌', d:'戊午', h:'巳'}（月/时为单地支，年/日为合法六十甲子）");
      }
      params.yj = opts.yj || '子';
      params.dt = { y: opts.dt.y, m: opts.dt.m, d: opts.dt.d, h: opts.dt.h, i: opts.dt.i !== undefined ? opts.dt.i : 0 };
      return params;
    }

    var d;
    if (opts.dt === undefined || opts.dt === null) {
      var now = new Date();
      d = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), i: now.getMinutes() };
    } else {
      d = Object.assign({}, opts.dt);
    }

    if (zhs === '活时报数') {
      if (opts.baoshu !== undefined && opts.baoshu !== null) {
        var h24 = baoshuToH24(opts.baoshu);
        d.h = h24[1]; d.i = 0;
      }
      params.dt = d;
      return params;
    }

    // 正时
    if (opts.lunar) {
      var gl = nlToGl(d.y, d.m, d.d);
      d.y = gl[0]; d.m = gl[1]; d.d = gl[2];
    }
    params.dt = d;
    return params;
  }

  function resolveIntent(raw) {
    raw = raw || {};
    var p = Object.assign({}, raw);
    var zhs = p.zhs || '正时';
    var dt = p.dt;
    var base = {
      grxz: p.grxz || '甲戊庚牛羊', zygr: p.zygr || '自动选择',
      sex: p.sex || '男', age: p.age !== undefined ? p.age : 18,
      glzxyj: p.glzxyj || '中气换将', shehai: p.shehai || '孟仲季',
    };

    if (zhs === '真太阳时') {
      if (!isGreg(dt, true)) throw new Error('真太阳时模式 dt 须为公历时间 {y,m,d,h,i}（东八区墙钟）');
      return buildParams({ zhs: '真太阳时', dt: dt, longitude: p.longitude || 120 });
    }
    if (zhs === '活时报数') {
      if (dt !== undefined && dt !== null && !isDate(dt)) {
        throw new Error('活时报数模式 dt 须为公历日期 {y,m,d}（时分支由报数决定）');
      }
      return buildParams(Object.assign({ zhs: '活时报数', dt: dt, baoshu: p.baoshu }, base));
    }
    if (zhs === '四柱') {
      if (!checkSizhuDt(dt)) {
        throw new Error("四柱模式 dt 须为干支串 {y:'甲子', m:'戌', d:'戊午', h:'巳'}（月/时为单地支，年/日为合法六十甲子）");
      }
      return buildParams(Object.assign({ zhs: '四柱', dt: dt, yj: p.yj }, base));
    }
    // 正时
    if (p.lunar) {
      if (!isGreg(dt)) throw new Error('正时(农历)模式 dt 须为农历日期 {y,m,d,h,i}');
      return buildParams(Object.assign({ zhs: '正时', dt: dt, lunar: true }, base));
    }
    if (dt !== undefined && dt !== null && !isGreg(dt)) {
      throw new Error('正时模式 dt 须为公历时间 {y,m,d,h,i}');
    }
    var params = Object.assign({}, base);
    Object.keys(p).forEach(function (k) { params[k] = p[k]; });
    return params;
  }

  var api = {
    paipan: paipan,
    resolveIntent: resolveIntent,
    buildParams: buildParams,
    baoshuToH24: baoshuToH24,
  };

  global.LiurenEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
