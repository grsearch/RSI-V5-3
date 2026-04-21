'use strict';
// src/logger.js
//
// ★ V5-4 FIX: winston 3.x 的格式化坑
//   1) 默认不支持 %s/%d 参数插值（必须加 splat()）
//   2) 即使加了 splat()，底层 util.format 也不支持 %.1f / %.2f 这类精度说明符
//      —— 这会导致：
//         logger.warn('跳跃 %.1f%% idx=%d', 23.45, 7)
//         实际输出："跳跃 %.1f% idx=23.45"  ← %.1f 原样保留、参数错位
//   3) 代码里已经大量使用 %.Nf 风格，不可能一条条改
//
//   解决方案：自定义 format，手工解析格式串，正确处理 %.Nf / %.Nd / %s / %d / %%
//
const winston = require('winston');

// 自定义 printf 风格格式化：支持 %s %d %f %j %.Nf %.Nd %+.Nf %%
function formatPrintf(tpl, args) {
  if (typeof tpl !== 'string' || args.length === 0) return tpl;
  let argIdx = 0;
  return tpl.replace(/%([+\- #0]*)(-?\d+)?(?:\.(\d+))?([sdifjxo%])/g, (match, flags, _width, precision, type) => {
    if (type === '%') return '%';
    if (argIdx >= args.length) return match;  // 参数不够，原样保留
    const v = args[argIdx++];
    const prec = precision != null ? parseInt(precision, 10) : null;
    const wantsSign = flags && flags.indexOf('+') >= 0;
    const signPrefix = (n) => (wantsSign && n >= 0 ? '+' : '');
    switch (type) {
      case 's': return String(v);
      case 'd':
      case 'i': {
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        const num = prec != null ? n.toFixed(prec) : String(Math.trunc(n));
        return signPrefix(n) + num;
      }
      case 'f': {
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        const num = prec != null ? n.toFixed(prec) : String(n);
        return signPrefix(n) + num;
      }
      case 'x': {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n).toString(16) : String(v);
      }
      case 'j':
        try { return JSON.stringify(v); } catch (_) { return String(v); }
      case 'o':
        try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { return String(v); }
      default:
        return match;
    }
  });
}

// winston 自定义 format：从 info[Symbol.for('splat')] 拿到原始参数，自己格式化
const SPLAT = Symbol.for('splat');
const customSplat = winston.format((info) => {
  const splat = info[SPLAT];
  if (splat && splat.length > 0 && typeof info.message === 'string') {
    info.message = formatPrintf(info.message, splat);
  }
  return info;
});

const logger = winston.createLogger({
  level : process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    customSplat(),   // ★ 自定义 splat：支持 %s %d %f %.Nf %.Nd 等
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/app.log',
      maxsize : 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

module.exports = logger;
