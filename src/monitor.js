'use strict';
// src/monitor.js — 核心监控引擎 V4
//
// V4 改进：
//   1. 去掉监控期限制和最大交易次数限制，代币持续监控直到手动移除
//   2. K线改为1分钟，止损轮询改为1分钟（可配置 SL_POLL_SEC）
//   3. 支持手动添加/删除代币
//   4. 卖出后不退出监控，重置状态等待下一个买入信号
//
// 交易生命周期：
//   addToken → [BUY → SELL → 冷却 → BUY → SELL → ...] → 手动移除 → removeToken

const EventEmitter = require('events');
const { evaluateSignal, buildCandles, filterValidCandles, checkStopLoss,
        calcRSIWithState, stepRSI,
        TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT } = require('./rsi');

// RSI 卖出阈值（从 CONFIG 取，与 rsi.js 保持一致）
const { CONFIG: RSI_CONFIG } = require('./rsi');
const _RSI_SELL  = RSI_CONFIG.RSI_SELL;
const _RSI_PANIC = RSI_CONFIG.RSI_PANIC;
const trader    = require('./trader');
const birdeye   = require('./birdeye');
const HIST_BARS = parseInt(process.env.HIST_BARS || '150', 10); // 启动时拉取的历史K线根数
const logger    = require('./logger');
const wsHub     = require('./wsHub');
const dataStore = require('./dataStore');
const heliusWs  = require('./heliusWs');

const FDV_EXIT          = parseFloat(process.env.FDV_EXIT_USD        || '30000');  // ★ V5: 改为3万
const LP_EXIT           = parseFloat(process.env.LP_EXIT_USD         || '10000');  // ★ V5: LP<1万退出
const POLL_SEC          = parseInt(process.env.PRICE_POLL_SEC        || '1',  10);
const KLINE_SEC         = parseInt(process.env.KLINE_INTERVAL_SEC    || '300', 10);
const DRY_RUN           = (process.env.DRY_RUN || 'false') === 'true';
const TRADE_SOL         = parseFloat(process.env.TRADE_SIZE_SOL      || '0.2');
const SELL_COOLDOWN_SEC = parseInt(process.env.SELL_COOLDOWN_SEC     || '1800', 10); // 默认30分钟
const SL_POLL_SEC       = parseInt(process.env.SL_POLL_SEC           || '60', 10);
const MAX_TOKENS        = parseInt(process.env.MAX_MONITOR_TOKENS    || '95', 10);  // ★ V5: 最大监控数
const OVERVIEW_PATROL_SEC = parseInt(process.env.OVERVIEW_PATROL_SEC || '7200', 10); // ★ V5: FDV/LP巡检间隔(秒)

// 全局交易记录
const _allTradeRecords = [];

function _loadPersistedTrades() {
  try {
    const trades = dataStore.loadTrades();
    const cutoff = Date.now() - 24 * 3600 * 1000;
    trades.filter(r => r.buyAt > cutoff).forEach(r => _allTradeRecords.push(r));
    if (_allTradeRecords.length > 0) {
      logger.info('[Monitor] 从磁盘加载了 %d 条交易记录', _allTradeRecords.length);
    }
  } catch (_) {}
}

// ★ V5-4: 历史K线 sanity check —— 过滤内部有异常跳跃的K线序列
//   返回过滤后的数组(截取到第一个异常点之后的部分,保留更近的可靠数据)
//   如果整体都异常,返回空数组
//
//   阈值说明（V5-4 从 V6 的 10% 放宽到 30%）：
//     Pump.fun 低流动性新币单根 5 分钟 K 线涨跌 10% 极为正常，不应视为异常。
//     只有 >30% 的相邻跳跃才认为是数据拼接错误/闪崩/价格源异常。
//     高低差阈值 hi-lo 由 50% 放宽到 80%（单根 K 线内部极大波动才算异常）。
//   阈值可通过环境变量覆盖：HIST_JUMP_MAX（默认 0.30）、HIST_HILOW_MAX（默认 0.80）。
const HIST_JUMP_MAX  = parseFloat(process.env.HIST_JUMP_MAX  || '0.30');
const HIST_HILOW_MAX = parseFloat(process.env.HIST_HILOW_MAX || '0.80');
function _sanitizeHistoricalCandles(candles, symbol) {
  if (!candles || candles.length < 2) return candles || [];
  // 从新到旧扫描(最近的在数组末尾),找到最近的"大跳"位置,丢弃跳前的所有K线
  let keepFromIdx = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (!prev.close || !cur.open) continue;
    const gap = Math.abs(cur.open - prev.close) / prev.close;
    // 相邻K线价格跳跃 > HIST_JUMP_MAX → 这是个异常点,只保留 i 之后的K线(包括 cur)
    if (gap > HIST_JUMP_MAX) {
      keepFromIdx = i;
      logger.warn('[Monitor] %s 历史K线内部价格跳跃(%.1f%% at idx=%d,阈值%.0f%%),丢弃前 %d 根,保留后 %d 根',
        symbol, gap * 100, i, HIST_JUMP_MAX * 100, i, candles.length - i);
      break;
    }
    // K线内部价格极端波动也视为异常(high/low 差 > HIST_HILOW_MAX)
    const hilow = cur.high && cur.low ? (cur.high - cur.low) / cur.low : 0;
    if (hilow > HIST_HILOW_MAX) {
      keepFromIdx = i;
      logger.warn('[Monitor] %s 历史K线内部波动极大(hi-lo %.1f%% at idx=%d,阈值%.0f%%),丢弃前 %d 根',
        symbol, hilow * 100, i, HIST_HILOW_MAX * 100, i);
      break;
    }
  }
  // 如果保留下来的太少(<K线20根),不如全部丢弃,等实时K线累积
  if (keepFromIdx > 0 && (candles.length - keepFromIdx) < 20) {
    logger.warn('[Monitor] %s 历史K线清洗后仅余 %d 根(不足20根),全部丢弃,等实时K线累积',
      symbol, candles.length - keepFromIdx);
    return [];
  }
  return candles.slice(keepFromIdx);
}

class TokenMonitor extends EventEmitter {
  constructor() {
    super();
    this._tokens    = new Map();
    this._pollTimer = null;
    this._started   = false;
    // 止损锁：防止同一 token 并发触发多次止损
    this._stopLossLocks = new Set();
    this._slPollTimer = null;  // 独立止损轮询
    this._persistTimer = null; // ★ V5: 定时持久化
  }

  start() {
    if (this._started) return;
    this._started = true;

    dataStore.init();
    _loadPersistedTrades();
    dataStore.startFlush();

    birdeye.priceStream.start();
    heliusWs.start();

    this._scheduleNextPoll();
    this._startStopLossPoller();  // ★ 500ms 独立止损轮询
    logger.info('[Monitor] 启动 | 轮询=%ds K线=%ds 止损轮询=%ds 冷却=%ds DRY_RUN=%s',
      POLL_SEC, KLINE_SEC, SL_POLL_SEC, SELL_COOLDOWN_SEC, DRY_RUN);
    logger.info('[Monitor]   BirdeyeWS=%s  HeliusWS=%s',
      birdeye.priceStream.isConnected() ? '已连接' : '连接中',
      heliusWs.isConnected() ? '已连接' : '连接中');
    logger.info('[Monitor]   移动止损=%s  激活线=+%s%%  回撤线=%s%%',
      TRAILING_STOP_ENABLED ? '开启' : '关闭', TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT);

    // ★ 加载持久化的代币列表（延迟500ms，等 WS 连接建立）
    setTimeout(() => this._loadPersistedTokens(), 500);

    // ★ V5: 定时持久化状态（每60秒），确保崩溃/重启后不丢失RSI预热和持仓
    this._persistTimer = setInterval(() => this._persistTokens(), 60000);

    // ★ V5: FDV/LP/Age 巡检（每 OVERVIEW_PATROL_SEC 秒一轮，分散请求）
    this._patrolTimer = null;
    this._startOverviewPatrol();
    logger.info('[Monitor]   FDV退出<$%d  LP退出<$%d  最大监控=%d  巡检=%ds',
      FDV_EXIT, LP_EXIT, MAX_TOKENS, OVERVIEW_PATROL_SEC);
  }

  _loadPersistedTokens() {
    try {
      const tokens = dataStore.loadTokens();
      if (!tokens || tokens.length === 0) return;
      logger.info('[Monitor] 从磁盘恢复 %d 个监控代币...', tokens.length);
      for (const t of tokens) {
        if (t.address && t.symbol) {
          const added = this.addToken(t.address, t.symbol, t.meta || {});
          if (!added) continue;

          // ★ V5: 恢复保存的运行状态
          const state = this._tokens.get(t.address);
          if (!state) continue;

          // 恢复 FDV/LP/Age
          if (t.fdv != null) state.fdv = t.fdv;
          if (t.lp != null) state.lp = t.lp;
          if (t.createdAt != null) state.createdAt = t.createdAt;

          // ★ 不恢复 RSI 缓存（_rsiAvgGain 等）— 从 ticks 重新计算
          //   旧缓存的 lastClose 跟当前价格可能差很远，stepRSI 会算出虚高RSI

          // 恢复持仓状态
          if (t.inPosition && t.position) {
            state.inPosition = true;
            state.position   = t.position;
            state.tradeCount = t.tradeCount || 0;
            logger.info('[Monitor] ♻️ 恢复 %s 持仓状态: entry=%.6f SOL=%.4f',
              t.symbol, t.position.entryPriceUsd, t.position.solIn);
          } else {
            state.tradeCount = t.tradeCount || 0;
          }

          // 恢复冷却期
          if (t._sellCooldownUntil && t._sellCooldownUntil > Date.now()) {
            state._sellCooldownUntil = t._sellCooldownUntil;
          }

          // ★ V5: 从磁盘加载历史 ticks 恢复 K 线数据
          try {
            const savedTicks = dataStore.loadTicks(t.address);
            if (savedTicks && savedTicks.length > 0) {
              // 加载最近2小时的 ticks（5分钟K线 × RSI(7) 需要至少9根 = 45分钟，留余量）
              const cutoff = Date.now() - 2 * 60 * 60 * 1000;
              const recentTicks = savedTicks.filter(tk => tk.ts > cutoff);
              if (recentTicks.length > 0) {
                state.ticks = recentTicks;
                logger.info('[Monitor] ♻️ 恢复 %s %d 条历史tick（最近2小时）',
                  t.symbol, recentTicks.length);
              }
            }
          } catch (_) {}

          // ★ 重启后重新拉取历史K线（historicalCandles 不持久化，重启必须重拉）
          birdeye.getOHLCV(t.address, KLINE_SEC, HIST_BARS).then(histCandles => {
            const s = this._tokens.get(t.address);
            if (!s || !histCandles || histCandles.length === 0) return;
            // ★ V6: sanity check
            const clean = _sanitizeHistoricalCandles(histCandles, t.symbol);
            if (clean.length > 0) {
              s.historicalCandles = clean;
              logger.info('[Monitor] ♻️ %s 历史K线重载: %d/%d 根', t.symbol, clean.length, histCandles.length);
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error('[Monitor] 加载持久化代币失败: %s', err.message);
    }
  }

  _persistTokens() {
    try {
      const list = Array.from(this._tokens.values()).map(s => ({
        address: s.address,
        symbol:  s.symbol,
        meta:    s.meta || {},
        // ★ V5: 保存运行状态，重启后不丢失
        fdv:            s.fdv,
        lp:             s.lp,
        createdAt:      s.createdAt,
        inPosition:     s.inPosition,
        position:       s.position,
        tradeCount:     s.tradeCount,
        _sellCooldownUntil: s._sellCooldownUntil,
        // ★ 不再保存 RSI 缓存状态（_rsiAvgGain 等）
        //   恢复后由 ticks 重新聚合 K 线重算，避免旧缓存与新 ticks 不匹配导致 RSI 虚高
      }));
      dataStore.saveTokens(list);
    } catch (_) {}
  }

  stop() {
    this._started = false;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    if (this._slPollTimer) { clearInterval(this._slPollTimer); this._slPollTimer = null; }
    if (this._persistTimer) { clearInterval(this._persistTimer); this._persistTimer = null; }
    if (this._patrolTimer) { clearTimeout(this._patrolTimer); this._patrolTimer = null; }
    this._persistTokens();  // ★ V5: 关闭前最后保存一次
    birdeye.priceStream.stop();
    heliusWs.stop();
    dataStore.stopFlush();
  }

  addToken(address, symbol, meta = {}) {
    if (this._tokens.has(address)) {
      logger.warn('[Monitor] %s 已在监控中，忽略', symbol);
      return false;
    }

    // ★ V5: 最大监控数检查
    if (this._tokens.size >= MAX_TOKENS) {
      const evicted = this._evictForNewToken();
      if (!evicted) {
        logger.warn('[Monitor] %s 无法添加：监控已满(%d/%d)', symbol, this._tokens.size, MAX_TOKENS);
        return false;
      }
    }

    const now = Date.now();
    const state = {
      address,
      symbol,
      meta,
      fdv               : meta.fdv ?? null,
      lp                : meta.lp  ?? null,
      createdAt         : meta.createdAt ?? null,  // ★ V5: 代币创建时间(ms)
      addedAt           : now,
      ticks             : [],
      historicalCandles : [],  // ★ 启动时从 Birdeye 拉取的历史K线（用于EMA99/RSI预热）
      inPosition        : false,
      position          : null,
      tradeCount        : 0,       // 完成的买卖轮次数
      tradeLogs         : [],
      tradeRecords      : [],
      _prevRsiRealtime  : NaN,
      _prevRsiTs        : 0,
      _lastBuyCandle    : -1,
      _lastSellCandle   : -1,
      _lastPanicSellTs  : 0,       // RSI_PANIC 时间防抖（毫秒时间戳）
      _lastPriceUsd     : null,
      _lastPriceTs      : 0,
      // ★ 实时 RSI 下穿检测缓存（每个 WS tick 更新，不依赖 1s 轮询）
      _rsiAvgGain       : NaN,     // 最新已收盘K线的 avgGain
      _rsiAvgLoss       : NaN,     // 最新已收盘K线的 avgLoss
      _rsiLastClose     : NaN,     // 最新已收盘K线的 close
      _rsiLastCandleTs  : -1,      // 对应的 K 线 openTime（用于检测 K 线是否刷新）
      _rsiClosedLast    : NaN,     // ★ V5-4: 最新已收盘K线的 RSI(供 WS tick 做二次确认,过滤stepRSI噪声)
      _rsiPrevTickRsi   : NaN,     // 保留字段（暂未使用）
      _slPollPrevRsi    : NaN,     // 500ms轮询的上一次实时RSI（用于下穿检测）
      _wsTickPrevRsi    : NaN,     // ★ WS tick的上一次实时RSI（用于下穿检测）
      _lastRsiCrossSellTs: 0,      // ★ RSI下穿70的时间防抖（毫秒时间戳）
      // ★ 多次买卖相关
      _sellCooldownUntil: 0,       // 卖出后冷却到期时间戳
      _selling          : false,   // 正在执行卖出中（防并发）
    };

    this._tokens.set(address, state);

    birdeye.priceStream.subscribe(address, (price, ts, ohlcv) => {
      this._onBirdeyePrice(address, price, ts);
    });

    heliusWs.subscribe(address, symbol, (trade) => {
      this._onChainTrade(address, trade);
    });

    // ★ 异步拉取 overview（Age/FDV/LP）+ 历史K线（EMA99/RSI预热）
    (async () => {
      const s = this._tokens.get(address);
      if (!s) return;

      // 1. 拉取 overview
      try {
        const ov = await birdeye.getOverview(address);
        if (ov) {
          if (ov.createdAt) s.createdAt = ov.createdAt;
          if (ov.fdv !== null && Number.isFinite(ov.fdv)) s.fdv = ov.fdv;
          if (ov.liquidity !== null && Number.isFinite(ov.liquidity)) s.lp = ov.liquidity;
          logger.debug('[Monitor] %s overview初始化: fdv=$%s age=%s',
            symbol,
            s.fdv ? Math.round(s.fdv) : '?',
            s.createdAt ? Math.round((Date.now() - s.createdAt) / 3600000) + 'h' : '?');
        }
      } catch (_) {}

      // 2. 拉取历史K线（用于 EMA99/RSI 预热，无需等待K线自然积累）
      try {
        const histCandles = await birdeye.getOHLCV(address, KLINE_SEC, HIST_BARS);
        if (histCandles && histCandles.length > 0) {
          // ★ V6: sanity check —— 过滤掉有异常跳跃的历史K线,避免污染RSI
          const clean = _sanitizeHistoricalCandles(histCandles, symbol);
          if (clean.length > 0) {
            s.historicalCandles = clean;
            logger.info('[Monitor] %s 历史K线预热: %d/%d 根 (EMA99/RSI立即可用)',
              symbol, clean.length, histCandles.length);
          } else {
            logger.warn('[Monitor] %s 历史K线全部不可信,不加载历史,等实时K线累积', symbol);
          }
        }
      } catch (_) {}
    })();

    logger.info("[Monitor] ➕ 开始监控 %s (%s) | DRY_RUN=%s",
      symbol, address, DRY_RUN);
    this._broadcastTokenList();
    this._persistTokens();  // ★ 保存到磁盘
    return true;
  }

  async removeToken(address, reason = 'manual') {
    const state = this._tokens.get(address);
    if (!state) return;

    logger.info('[Monitor] ➖ 移除 %s，原因: %s (共完成%d笔交易)', state.symbol, reason, state.tradeCount);

    // 到期/手动移除时如仍持仓，强制卖出（force=true 绕过同根K线保护）
    if (state.inPosition && !state._selling) {
      logger.info('[Monitor] 📤 持仓中，先执行卖出...');
      await this._doSell(state, `FORCED_EXIT(${reason})`, { force: true });
    }

    dataStore.flushTicks();

    birdeye.priceStream.unsubscribe(address);
    heliusWs.unsubscribe(address);

    this._tokens.delete(address);
    this._stopLossLocks.delete(address);
    birdeye.clearCache(address);
    this._broadcastTokenList();
    this._persistTokens();  // ★ 保存到磁盘
  }

  getTokens() {
    return Array.from(this._tokens.values()).map(s => this._stateSnapshot(s));
  }

  getToken(address) {
    const s = this._tokens.get(address);
    return s ? this._stateSnapshot(s) : null;
  }

  // ── Birdeye WS 实时价格回调（<150ms 延迟） ─────────────────────

  _onBirdeyePrice(address, price, ts) {
    const state = this._tokens.get(address);
    if (!state) return;

    state._lastPriceUsd = price;
    state._lastPriceTs  = ts;

    const tick = { price, ts, source: 'price' };
    state.ticks.push(tick);

    dataStore.appendTick(address, {
      price, ts, source: 'price', symbol: state.symbol,
    });

    // ★ 快速止损检查（持仓中 + 未在卖出中）
    if (state.inPosition && !state._selling && !this._stopLossLocks.has(address)) {
      const sl = checkStopLoss(price, state);
      if (sl.shouldExit) {
        logger.info('[Monitor] ⚡ 快速止损触发 %s @ %.8f | %s | 第%d笔',
          state.symbol, price, sl.reason, state.tradeCount + 1);
        this._stopLossLocks.add(address);
        this._doSell(state, sl.reason).catch(err => {
          logger.error('[Monitor] 快速止损执行失败 %s: %s', state.symbol, err.message);
        }).finally(() => {
          this._stopLossLocks.delete(address);
        });
        return; // 已触发卖出，不再检查 RSI
      }

      // ★★ 实时 RSI 卖出检查（每个 WS tick 都算，不等 K 线收盘）
      this._checkRealtimeRsiSell(state, price);
    }
  }

  /**
   * ★ V5 修复: 实时 RSI 卖出检查
   *   - RSI恐慌卖(>80): 只信任已收盘K线RSI，不用stepRSI（避免K线内波动导致虚假高RSI）
   *   - RSI下穿70: 仍用stepRSI实时检测（下穿检测对精度要求低于绝对值判断）
   */
  _checkRealtimeRsiSell(state, price) {
    const avgGain   = state._rsiAvgGain;
    const avgLoss   = state._rsiAvgLoss;
    const lastClose = state._rsiLastClose;
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss) || !Number.isFinite(lastClose)) return;

    // 用当前实时价格计算实时 RSI
    const rsiNow = stepRSI(avgGain, avgLoss, lastClose, price);
    if (!Number.isFinite(rsiNow)) return;

    const prevRsi = state._wsTickPrevRsi;
    const now = Date.now();

    // 更新上一次的实时 RSI（用于下穿检测）
    state._wsTickPrevRsi = rsiNow;

    if (!Number.isFinite(prevRsi)) return; // 第一个 tick，没有 prev，跳过

    // ── RSI > 80 恐慌卖 — ★ V5 改为只在主轮询的已收盘K线RSI中触发 ──
    //    stepRSI 在K线内波动剧烈时容易算出虚假高值（如95），
    //    而已收盘K线RSI更稳定、与交易所显示一致。
    //    此处不再处理 RSI_PANIC，由 evaluateSignal 和 _stopLossPoll 负责。

    // ── RSI 下穿 70（实时：prevRsi >= 70 且 rsiNow < 70）──
    //    下穿检测只看方向变化，对绝对值精度要求低，stepRSI可信
    //    ★ V6: 加 RSI 跳跃保护
    //    ★ V5-4: 加已收盘RSI二次确认 —— 过滤stepRSI在K线内的噪声触发
    if (prevRsi >= _RSI_SELL && rsiNow < _RSI_SELL) {
      const rsiJump = Math.abs(prevRsi - rsiNow);
      if (rsiJump > 30) {
        // 两次WS tick之间RSI变化>30 → 脏数据,不触发并标记清缓存
        state._rsiDataTainted = true;
      } else {
        // ★ V5-4: 要求已收盘K线RSI >= RSI_RT_CONFIRM_MIN (默认65)
        //   如果最近一根已收盘K线RSI都不到65,说明stepRSI算出的 prevRsi>=70 很可能是K线内价格噪声
        //   (例如图4:价格短时抖动触发 72.5→68.5 假下穿,而实际已收盘RSI只有40-50)
        const rsiClosedLast = state._rsiClosedLast;
        const RSI_RT_CONFIRM_MIN = parseFloat(process.env.RSI_RT_CONFIRM_MIN || '65');
        if (!Number.isFinite(rsiClosedLast) || rsiClosedLast < RSI_RT_CONFIRM_MIN) {
          // 已收盘RSI不够高,这是stepRSI噪声,不触发
          const lastSkipLog = state._lastRtSkipLogTs ?? 0;
          if (now - lastSkipLog > 10000) {
            state._lastRtSkipLogTs = now;
            logger.info('[Monitor] 🛡 %s WS RSI下穿忽略(stepRSI噪声) RT:%.1f→%.1f 但已收盘RSI=%s<%d',
              state.symbol, prevRsi, rsiNow,
              Number.isFinite(rsiClosedLast) ? rsiClosedLast.toFixed(1) : 'NaN',
              RSI_RT_CONFIRM_MIN);
          }
        } else {
          const lastCrossTs = state._lastRsiCrossSellTs ?? 0;
          if (now - lastCrossTs >= 2000) {
            state._lastRsiCrossSellTs = now;
            logger.info('[Monitor] ⚡ WS实时RSI下穿卖出 %s @ %.8f | RSI %.1f→%.1f (已收盘%.1f)',
              state.symbol, price, prevRsi, rsiNow, rsiClosedLast);
            this._doSell(state, `RSI_CROSS_DOWN_70_RT(${prevRsi.toFixed(1)}→${rsiNow.toFixed(1)},K=${rsiClosedLast.toFixed(1)})`).catch(err => {
              logger.error('[Monitor] WS RSI下穿卖出失败 %s: %s', state.symbol, err.message);
            });
          }
        }
      }
    }
  }

  // ── Helius 链上交易回调 ──────────────────────────────────────

  _onChainTrade(address, trade) {
    const state = this._tokens.get(address);
    if (!state) return;

    const now = Date.now();
    const tick = {
      price:     trade.priceSol,
      ts:        trade.ts || now,
      solAmount: trade.solAmount,
      isBuy:     trade.isBuy,
      source:    'chain',
    };

    state.ticks.push(tick);

    // ★ FIX: 链上交易到达就实时更新 _lastVolume（滑动窗口），
    //   这样 token_list 广播 / tick 广播 / REST 接口都能立刻看到最新买卖量，
    //   不用等下一次 _poll 跑 buildCandles+evaluateSignal 才显示。
    this._refreshLiveVolume(state, now);

    dataStore.appendTick(address, {
      ...tick,
      symbol:    state.symbol,
      signature: trade.signature,
      owner:     trade.owner,
    });

    // ★ 链上交易也触发止损检查（用链上价格 × SOL/USD 估算）
    // 链上交易比 Birdeye WS 更快到达，不浪费这个信号
    if (state.inPosition && !state._selling && !this._stopLossLocks.has(address)) {
      // 用最新的 Birdeye USD 价格做止损判断（链上 priceSol 单位不同，不能直接比）
      // 但如果有卖出交易且价格大幅下跌，说明市场在抛售
      const lastUsd = state._lastPriceUsd;
      if (lastUsd && trade.isBuy === false && trade.solAmount > 5) {
        // 大额卖出交易 → 触发紧急价格刷新
        this._urgentStopCheck(address, state);
      }
    }

    // 大额交易记 info 日志（方便人工核对和 GMGN 对账）
    if (trade.solAmount >= 1.0) {
      logger.info('[HeliusTrade] %s %s %.3f SOL @ %.10f (%s)',
        state.symbol,
        trade.isBuy ? 'BUY' : 'SELL',
        trade.solAmount,
        trade.priceSol,
        trade.signature?.slice(0, 16) || '?');
    } else {
      logger.debug('[HeliusTrade] %s %s %.4f SOL @ %.10f (%s)',
        state.symbol,
        trade.isBuy ? 'BUY' : 'SELL',
        trade.solAmount,
        trade.priceSol,
        trade.signature?.slice(0, 12) || '?');
    }
  }

  // ── 紧急止损价格刷新（链上检测到大额卖出时触发）────────────
  async _urgentStopCheck(address, state) {
    if (state._selling || this._stopLossLocks.has(address)) return;
    try {
      // 绕过缓存直接拉最新价格
      const price = await birdeye.getPrice(address);
      if (!price || price <= 0) return;
      state._lastPriceUsd = price;
      state._lastPriceTs = Date.now();

      const sl = checkStopLoss(price, state);
      if (sl.shouldExit) {
        logger.info('[Monitor] ⚡ 链上大卖触发止损 %s @ %.8f | %s', state.symbol, price, sl.reason);
        this._stopLossLocks.add(address);
        this._doSell(state, sl.reason).catch(err => {
          logger.error('[Monitor] 紧急止损失败 %s: %s', state.symbol, err.message);
        }).finally(() => {
          this._stopLossLocks.delete(address);
        });
      }
    } catch (_) {}
  }

  // ── 独立止损轮询（每 500ms，不依赖 WS 推送） ─────────────────

  _startStopLossPoller() {
    if (this._slPollTimer) return;
    this._slPollTimer = setInterval(() => this._stopLossPoll(), SL_POLL_SEC * 1000);
  }

  async _stopLossPoll() {
    for (const [address, state] of this._tokens.entries()) {
      if (!state.inPosition || state._selling || this._stopLossLocks.has(address)) continue;

      try {
        // ★ V5: 优先用 WS 缓存价格（10秒内有效），避免对所有持仓币发 HTTP
        //   只有 WS 价格过期超过60秒才发 HTTP 兜底
        let price = birdeye.priceStream.getCachedPrice(address);
        if (price === null) {
          // WS 缓存失效，检查 state 里最近的价格是否够新（60秒内）
          if (state._lastPriceUsd && Date.now() - state._lastPriceTs < 60000) {
            price = state._lastPriceUsd;
          } else {
            price = await birdeye.getPrice(address);
          }
        }
        if (!price || price <= 0) continue;

        state._lastPriceUsd = price;
        state._lastPriceTs = Date.now();

        // ── 1. 止损/移动止损检查 ──────────────────────────────
        const sl = checkStopLoss(price, state);
        if (sl.shouldExit) {
          const holdSec = state.position?.buyTime ? Math.round((Date.now() - state.position.buyTime) / 1000) : 0;
          logger.info('[Monitor] ⚡ 止损轮询触发 %s @ %.8f | %s | 持仓%ds',
            state.symbol, price, sl.reason, holdSec);
          this._stopLossLocks.add(address);
          this._doSell(state, sl.reason).catch(err => {
            logger.error('[Monitor] 止损执行失败 %s: %s', state.symbol, err.message);
          }).finally(() => {
            this._stopLossLocks.delete(address);
          });
          continue;
        }

        // ── 2. RSI 卖出检查（双重方式：已收盘K线 + stepRSI实时估算） ──
        if (state.ticks.length > 0) {
          const { closed: rawCandles } = buildCandles(state.ticks, KLINE_SEC);
          const liveCandles = filterValidCandles(rawCandles); // RSI用
          // ★ 合并历史K线（RSI用）—— 应用同样的价格连续性检查
          let closedCandles = liveCandles;
          if (!state._historicalCandlesDisabled && state.historicalCandles && state.historicalCandles.length > 0) {
            const liveStart2 = liveCandles.length > 0 ? liveCandles[0].openTime : Infinity;
            const histFiltered2 = state.historicalCandles.filter(c => c.openTime < liveStart2);
            if (histFiltered2.length > 0 && liveCandles.length > 0) {
              const histLastClose = histFiltered2[histFiltered2.length - 1].close;
              const liveFirstOpen = liveCandles[0].open;
              if (histLastClose > 0 && liveFirstOpen > 0) {
                const jumpPct = Math.abs(liveFirstOpen - histLastClose) / histLastClose;
                // ★ V5-4: 与主路径保持一致,使用 HIST_JUMP_MAX（默认 30%）
                if (jumpPct > HIST_JUMP_MAX) {
                  state._historicalCandlesDisabled = true;
                }
              }
            }
            if (!state._historicalCandlesDisabled) {
              closedCandles = [...histFiltered2, ...liveCandles];
            }
          }
          if (closedCandles.length >= RSI_CONFIG.RSI_PERIOD + 2) {
            const closes = closedCandles.map(c => c.close);
            const { rsiArray, avgGain, avgLoss } = calcRSIWithState(closes);
            const len     = closes.length;

            // ★ 同时缓存 avgGain/avgLoss/lastClose，供 WS tick 实时 RSI 使用
            const lastCandleTsPoll = closedCandles[len - 1].openTime;
            if (lastCandleTsPoll !== state._rsiLastCandleTs) {
              state._rsiAvgGain     = avgGain;
              state._rsiAvgLoss     = avgLoss;
              state._rsiLastClose   = closes[len - 1];
              state._rsiLastCandleTs = lastCandleTsPoll;
            }
            // ★ V5-4: 总是更新 _rsiClosedLast（不受 K 线是否翻新影响）
            //   供 WS tick 快速路径做二次确认，避免 stepRSI 噪声误触发
            state._rsiClosedLast = rsiArray[len - 1];

            // ★ 用 stepRSI 计算实时 RSI（基于当前价格，而非等K线收盘）
            const rsiRealtime = stepRSI(avgGain, avgLoss, closes[len - 1], price);
            const rsiClosedLast = rsiArray[len - 1];  // 最新已收盘K线RSI（作为 prev 参考）

            // 取上一次轮询的实时 RSI 作为 prevRsi
            const prevRsiPoll = state._slPollPrevRsi;
            state._slPollPrevRsi = rsiRealtime;  // 保存本次，供下次比较

            if (Number.isFinite(rsiRealtime)) {
              // ★ V5: RSI > 80 恐慌卖 — 改为用已收盘K线RSI判断，不用stepRSI
              //   stepRSI在K线内波动时容易算出虚假高值
              // ★ V6: 连续2根K线都>RSI_PANIC才触发，防止单根K线异常值误触发
              // ★ V5-4: 加价格真实性验证 —— 历史K线拼接处可能造成 rsiArray 整段虚高(图2/3)
              //   要求最近一根已收盘K线的收盘价 > 最近 N 根均价 * RSI_PANIC_PRICE_MULT
              //   如果价格根本没真正上涨,RSI 显示 >80 必然是数据污染
              if (Number.isFinite(rsiClosedLast) && rsiClosedLast > _RSI_PANIC) {
                const rsiPrevClosedForPanic = rsiArray[len - 2];
                const panicConfirmed = Number.isFinite(rsiPrevClosedForPanic) && rsiPrevClosedForPanic > _RSI_PANIC;

                // V5-4: 价格真实性检查 —— 最新收盘价 vs 最近20根K线均价
                const priceSanityBars = Math.min(20, len);
                let avgRecent = 0;
                for (let i = len - priceSanityBars; i < len; i++) avgRecent += closes[i];
                avgRecent /= priceSanityBars;
                const lastClose = closes[len - 1];
                const priceRise = avgRecent > 0 ? (lastClose - avgRecent) / avgRecent : 0;
                const RSI_PANIC_PRICE_MIN_RISE = parseFloat(process.env.RSI_PANIC_PRICE_MIN_RISE || '0.03');
                const priceRealisticallyHigh = priceRise >= RSI_PANIC_PRICE_MIN_RISE;

                if (panicConfirmed && priceRealisticallyHigh) {
                  const lastPanicTs = state._lastPanicSellTs ?? 0;
                  if (Date.now() - lastPanicTs >= 2000) {
                    state._lastPanicSellTs = Date.now();
                    logger.info('[Monitor] ⚡ RSI恐慌卖出(K线) %s @ %.8f | RSI_K=%.1f,%.1f>%d | 价格+%.1f%%',
                      state.symbol, price, rsiPrevClosedForPanic, rsiClosedLast, _RSI_PANIC, priceRise * 100);
                    this._doSell(state, `RSI_PANIC(K=${rsiPrevClosedForPanic.toFixed(1)},${rsiClosedLast.toFixed(1)}>${_RSI_PANIC},+${(priceRise*100).toFixed(1)}%)`).catch(err => {
                      logger.error('[Monitor] RSI恐慌卖出失败 %s: %s', state.symbol, err.message);
                    });
                  }
                } else if (!priceRealisticallyHigh) {
                  // 价格没真涨但 RSI 说 >80 → 数据污染，标记并清缓存
                  const lastSkipLog = state._lastPanicSkipLogTs ?? 0;
                  if (Date.now() - lastSkipLog > 10000) {
                    state._lastPanicSkipLogTs = Date.now();
                    logger.warn('[Monitor] 🛡 %s RSI=%.1f>%d 但价格仅%+.1f%%<%d%%,判定为脏数据,跳过恐慌',
                      state.symbol, rsiClosedLast, _RSI_PANIC,
                      priceRise * 100, Math.round(RSI_PANIC_PRICE_MIN_RISE * 100));
                  }
                  // 标记污染让下轮 _poll 重建历史K线
                  state._rsiDataTainted = true;
                } else {
                  logger.warn('[Monitor] %s RSI异常高值不触发恐慌 last=%.1f prev=%s (需连续2根>%d)',
                    state.symbol, rsiClosedLast,
                    Number.isFinite(rsiPrevClosedForPanic) ? rsiPrevClosedForPanic.toFixed(1) : 'NaN',
                    _RSI_PANIC);
                }
              }
              // RSI 下穿70：支持两种 prev 来源
              //   a) 上次轮询的实时 RSI (prevRsiPoll) — 500ms 间隔的 tick-to-tick 比较
              //   b) 最新已收盘K线 RSI (rsiClosedLast) — K线级别的下穿
              //   ★ V6: 两条分支都加 RSI 跳跃保护(>30 视为脏数据)
              //   ★ V5-4: RT 分支加已收盘RSI二次确认,过滤stepRSI噪声
              else if (Number.isFinite(prevRsiPoll) && prevRsiPoll >= _RSI_SELL && rsiRealtime < _RSI_SELL) {
                const rsiJump = Math.abs(prevRsiPoll - rsiRealtime);
                if (rsiJump > 30) {
                  state._rsiDataTainted = true;
                  logger.warn('[Monitor] %s 轮询RT RSI跳跃异常(%.1f→%.1f,差%.1f),跳过',
                    state.symbol, prevRsiPoll, rsiRealtime, rsiJump);
                } else {
                  // ★ V5-4: 已收盘RSI二次确认
                  const RSI_RT_CONFIRM_MIN = parseFloat(process.env.RSI_RT_CONFIRM_MIN || '65');
                  if (!Number.isFinite(rsiClosedLast) || rsiClosedLast < RSI_RT_CONFIRM_MIN) {
                    const lastSkipLog = state._lastRtSkipLogTsPoll ?? 0;
                    if (Date.now() - lastSkipLog > 10000) {
                      state._lastRtSkipLogTsPoll = Date.now();
                      logger.info('[Monitor] 🛡 %s 轮询RT RSI下穿忽略(stepRSI噪声) %.1f→%.1f 但已收盘RSI=%s<%d',
                        state.symbol, prevRsiPoll, rsiRealtime,
                        Number.isFinite(rsiClosedLast) ? rsiClosedLast.toFixed(1) : 'NaN',
                        RSI_RT_CONFIRM_MIN);
                    }
                  } else {
                    const lastCrossTs = state._lastRsiCrossSellTs ?? 0;
                    if (Date.now() - lastCrossTs >= 2000) {
                      state._lastRsiCrossSellTs = Date.now();
                      logger.info('[Monitor] ⚡ RSI下穿卖出(轮询RT) %s @ %.8f | RSI %.1f→%.1f (已收盘%.1f)',
                        state.symbol, price, prevRsiPoll, rsiRealtime, rsiClosedLast);
                      this._doSell(state, `RSI_CROSS_DOWN_70(RT:${prevRsiPoll.toFixed(1)}→${rsiRealtime.toFixed(1)},K=${rsiClosedLast.toFixed(1)})`).catch(err => {
                        logger.error('[Monitor] RSI下穿卖出失败 %s: %s', state.symbol, err.message);
                      });
                    }
                  }
                }
              }
              // 备用：已收盘K线级别下穿（保留原逻辑作为兜底）
              else if (Number.isFinite(rsiClosedLast)) {
                const rsiPrevClosed = rsiArray[len - 2];
                if (Number.isFinite(rsiPrevClosed) && rsiPrevClosed >= _RSI_SELL && rsiClosedLast < _RSI_SELL) {
                  // ★ V6: RSI 两根相邻K线的变化应该 ≤ 30(RSI 真实波动不可能一根K线跳 47 点)
                  //   超过 30 很可能是历史K线和实时K线拼接处的虚假数据,拒绝触发
                  const rsiJump = Math.abs(rsiPrevClosed - rsiClosedLast);
                  if (rsiJump > 30) {
                    logger.warn('[Monitor] %s RSI相邻K线跳跃异常(%.1f→%.1f,差%.1f),跳过下穿70判定',
                      state.symbol, rsiPrevClosed, rsiClosedLast, rsiJump);
                    // 同时标记历史K线污染,下次 _poll 会禁用历史K线
                    state._historicalCandlesDisabled = true;
                    // 清空 RSI 缓存,强制下次用纯实时K线重算
                    state._rsiAvgGain = NaN;
                    state._rsiAvgLoss = NaN;
                    state._rsiLastClose = NaN;
                    state._rsiLastCandleTs = -1;
                    state._rsiClosedLast = NaN;
                    state._slPollPrevRsi = NaN;
                    state._wsTickPrevRsi = NaN;
                  } else {
                    const candleTs = closedCandles[len - 1].openTime;
                    if (candleTs !== state._lastSellCandle) {
                      state._lastSellCandle = candleTs;
                      logger.info('[Monitor] ⚡ RSI下穿卖出(K线) %s @ %.8f | RSI %.1f→%.1f',
                        state.symbol, price, rsiPrevClosed, rsiClosedLast);
                      this._doSell(state, `RSI_CROSS_DOWN_70(K:${rsiPrevClosed.toFixed(1)}→${rsiClosedLast.toFixed(1)})`).catch(err => {
                        logger.error('[Monitor] RSI下穿卖出失败 %s: %s', state.symbol, err.message);
                      });
                    }
                  }
                }
              }
            }
          }
        }
      } catch (_) {}
    }
  }

  // ── 主轮询 ────────────────────────────────────────────────────

  _scheduleNextPoll() {
    if (!this._started) return;
    this._pollTimer = setTimeout(() => this._poll(), POLL_SEC * 1000);
  }

  async _poll() {
    const now = Date.now();
    const addresses = Array.from(this._tokens.keys());

    // ★ V5: 并发控制 — 最多10个同时执行，避免47+币同时发HTTP请求
    const CONCURRENCY = 10;
    for (let i = 0; i < addresses.length; i += CONCURRENCY) {
      const batch = addresses.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(addr => this._pollOne(addr, now)));
    }
    this._scheduleNextPoll();
  }

  async _pollOne(address, now) {
    const state = this._tokens.get(address);
    if (!state) return;

    // 正在卖出中，跳过此轮
    if (state._selling) return;

    // 1. 获取价格
    // ★ 优先用 BirdeyeWS 已推送的最新价格（state._lastPriceUsd 由 _onBirdeyePrice 实时更新）
    //   只有 WS 价格超过 PRICE_STALE_MS 没更新，才发 HTTP 兜底请求
    //   这样避免每秒对48个币发HTTP，尤其是低流动性币WS长时间不推送的情况
    const PRICE_STALE_MS = parseInt(process.env.PRICE_STALE_MS || '60000', 10); // ★ V5: 默认60秒
    let price;
    const wsAge = state._lastPriceUsd ? now - state._lastPriceTs : Infinity;
    if (state._lastPriceUsd && wsAge < PRICE_STALE_MS) {
      // WS 价格足够新鲜，直接用，不发 HTTP
      price = state._lastPriceUsd;
    } else {
      // WS 价格过期或没有，发 HTTP 兜底
      try {
        price = await birdeye.getPrice(address);
        if (price && price > 0) {
          state._lastPriceUsd = price;
          state._lastPriceTs  = now;
        }
      } catch (err) {
        logger.warn('[Monitor] %s 价格拉取失败: %s', state.symbol, err.message);
        // 如果有旧价格，宁可用旧的继续跑 RSI，不要直接 return
        if (!state._lastPriceUsd) return;
        price = state._lastPriceUsd;
      }
    }
    if (!price || price <= 0) return;

    // 2. WS 不可用时补 tick（仅在 HTTP 兜底拉到新价格时才需要，WS 正常时由 _onBirdeyePrice 负责）
    if (wsAge >= PRICE_STALE_MS) {
      const tick = { price, ts: now, source: 'price' };
      state.ticks.push(tick);
      dataStore.appendTick(address, { price, ts: now, source: 'price', symbol: state.symbol });
    }

    // 4. FDV/LP 检查（只用缓存值，巡检会定期刷新）
    const fdv = birdeye.getCachedFdv(address);
    if (fdv !== null && Number.isFinite(fdv)) {
      state.fdv = fdv;  // 更新state
      if (fdv < FDV_EXIT) {
        logger.warn('[Monitor] %s FDV=$%d < $%d，退出', state.symbol, Math.round(fdv), FDV_EXIT);
        await this.removeToken(address, `FDV_TOO_LOW($${Math.round(fdv)})`);
        return;
      }
    }
    // LP 退出检查（用 state 中巡检更新的值）
    if (state.lp !== null && Number.isFinite(state.lp) && state.lp < LP_EXIT) {
      logger.warn('[Monitor] %s LP=$%d < $%d，退出', state.symbol, Math.round(state.lp), LP_EXIT);
      await this.removeToken(address, `LP_TOO_LOW($${Math.round(state.lp)})`);
      return;
    }

    // 5. 裁剪 ticks（保留最近 2 小时）
    // ★ V5: 用 findIndex+splice 替代 while+shift，O(1) vs O(n)
    const cutoff = now - 2 * 60 * 60 * 1000;
    if (state.ticks.length > 0 && state.ticks[0].ts < cutoff) {
      const idx = state.ticks.findIndex(t => t.ts >= cutoff);
      if (idx > 0) state.ticks.splice(0, idx);
      else if (idx === -1) state.ticks.length = 0;  // 全部过期
    }

    // 6. 聚合 K 线（历史K线 + 实时ticks合并）
    const { closed: rawClosedCandles, current: currentCandle } = buildCandles(state.ticks, KLINE_SEC);
    const liveClosed = filterValidCandles(rawClosedCandles); // RSI用：只含真实价格K线

    // ★ V6: RSI 污染标记传播 —— evaluateSignal 检测到 RSI 相邻值跳跃 >30 会设置此标记
    //   收到标记后禁用历史K线并清空RSI缓存,让下次重算用纯实时K线
    if (state._rsiDataTainted) {
      state._historicalCandlesDisabled = true;
      state._rsiAvgGain = NaN;
      state._rsiAvgLoss = NaN;
      state._rsiLastClose = NaN;
      state._rsiLastCandleTs = -1;
      state._rsiClosedLast = NaN;
      state._slPollPrevRsi = NaN;
      state._wsTickPrevRsi = NaN;
      state._prevRsiRealtime = NaN;
      state._rsiDataTainted = false;
      logger.warn('[Monitor] %s RSI数据被标记污染,已禁用历史K线并清空RSI缓存',
        state.symbol);
    }

    // ★ 合并历史K线（RSI/EMA用）：历史candles在前，实时candles在后
    let closedCandles = liveClosed;
    if (state.historicalCandles && state.historicalCandles.length > 0) {
      const liveStart = liveClosed.length > 0 ? liveClosed[0].openTime : Infinity;
      const histFiltered = state.historicalCandles.filter(c => c.openTime < liveStart);
      // ★ FIX: 历史K线和实时K线的拼接处如果价格跳跃过大,会导致RSI算出虚假高值(>90)
      //   这种情况丢弃历史K线,只用实时数据(等K线自然累积)
      if (histFiltered.length > 0 && liveClosed.length > 0 && !state._historicalCandlesDisabled) {
        const histLastClose = histFiltered[histFiltered.length - 1].close;
        const liveFirstOpen = liveClosed[0].open;
        if (histLastClose > 0 && liveFirstOpen > 0) {
          const jumpPct = Math.abs(liveFirstOpen - histLastClose) / histLastClose;
          // ★ V5-4: 阈值从 10% 放宽到 HIST_JUMP_MAX（默认 30%），避免 Pump.fun 新币误伤
          if (jumpPct > HIST_JUMP_MAX) {
            logger.warn('[Monitor] %s 历史K线和实时K线拼接处价格跳跃过大(%.1f%%,阈值%.0f%%),仅使用实时K线',
              state.symbol, jumpPct * 100, HIST_JUMP_MAX * 100);
            state._historicalCandlesDisabled = true;
          }
        }
        // ★ V5-4: 再加一层 —— 直接检查历史K线内部有没有相邻大跳(> HIST_JUMP_MAX),有就禁用
        if (!state._historicalCandlesDisabled) {
          for (let i = 1; i < histFiltered.length; i++) {
            const prev = histFiltered[i - 1];
            const cur = histFiltered[i];
            if (prev.close > 0 && cur.open > 0) {
              const gap = Math.abs(cur.open - prev.close) / prev.close;
              if (gap > HIST_JUMP_MAX) {
                logger.warn('[Monitor] %s 历史K线内部价格跳跃过大(%.1f%% at idx=%d,阈值%.0f%%),仅使用实时K线',
                  state.symbol, gap * 100, i, HIST_JUMP_MAX * 100);
                state._historicalCandlesDisabled = true;
                break;
              }
            }
          }
        }
      }
      if (!state._historicalCandlesDisabled) {
        closedCandles = [...histFiltered, ...liveClosed];
      }
    }
    // ★ 量能用：原始K线（含无价格的链上K线）+ 当前未收盘K线，历史K线在前
    // currentCandle 包含当前5分钟窗口内最新的链上交易，必须纳入量能统计
    const rawLiveAll = currentCandle
      ? [...rawClosedCandles, currentCandle]
      : rawClosedCandles;
    let rawForVolume = rawLiveAll;
    if (state.historicalCandles && state.historicalCandles.length > 0) {
      const liveStart = rawLiveAll.length > 0 ? rawLiveAll[0].openTime : Infinity;
      const histFiltered = state.historicalCandles.filter(c => c.openTime < liveStart);
      rawForVolume = [...histFiltered, ...rawLiveAll];
    }

    // 7. RSI + 量能信号评估
    const realtimePrice = currentCandle?.close ?? price;

    // ★ 诊断日志：打印量能数据来源（每个币每60秒一次）
    if (!state._lastVolLog || Date.now() - state._lastVolLog > 60000) {
      state._lastVolLog = Date.now();
      const chainTicks = state.ticks.filter(t => t.source === 'chain');
      const windowMs = (parseInt(process.env.VOL_WINDOW_SEC || '300', 10)) * 1000;
      const cutoff = Date.now() - windowMs;
      const winChainTicks = chainTicks.filter(t => t.ts >= cutoff);
      let winBuy = 0, winSell = 0;
      for (const t of winChainTicks) {
        const amt = t.solAmount || 0;
        if (t.isBuy) winBuy += amt; else winSell += amt;
      }
      const rawChainBuys  = rawForVolume.filter(c => !c.fromHistory).reduce((s,c)=>s+(c.buyVolume||0),0);
      const rawChainSells = rawForVolume.filter(c => !c.fromHistory).reduce((s,c)=>s+(c.sellVolume||0),0);
      logger.info('[VolDiag] %s | chainTicks:all=%d,win=%d | tick路径=B%.3f/S%.3f | K线路径=B%.3f/S%.3f | win=%ds',
        state.symbol,
        chainTicks.length,
        winChainTicks.length,
        winBuy, winSell,
        rawChainBuys, rawChainSells,
        windowMs/1000
      );
    }

    const { rsi, prevRsi, signal, reason, volume, candleTs: signalCandleTs } = evaluateSignal(closedCandles, realtimePrice, state, rawForVolume);

    // ★ FIX: 缓存到 state，让 _stateSnapshot (getTokens/token_list/REST) 也能读到量能
    state._lastRsi         = Number.isFinite(rsi)     ? parseFloat(rsi.toFixed(2))     : null;
    state._lastPrevRsi     = Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null;
    state._lastSignal      = signal || null;
    state._lastReason      = reason || '';
    state._lastClosedCount = closedCandles.length;

    // ★ FIX: 显示层统一用 _refreshLiveVolume —— 严格 VOL_WINDOW_SEC 秒的滑动窗口
    //   不再和 evaluateSignal 返回的 K 线量能做 Math.max 合并，避免：
    //     1. 两条路径窗口不同，取 max 会把数据虚高
    //     2. K 线 currentCandle 窗口随机（0~300s），显示"300s"容易误导
    //   信号判断 (evaluateSignal 内部) 仍然用 K 线聚合，两者职责分离
    this._refreshLiveVolume(state, now, true);
    const displayVolume = state._lastVolume;

    // 8. 记录信号
    if (reason && reason !== '' && reason !== 'rsi_rebase') {
      dataStore.appendSignal({
        ts: now, address, symbol: state.symbol,
        price, rsi: Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
        prevRsi: Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
        signal, reason, volume, inPosition: state.inPosition,
        tradeCount: state.tradeCount,
      });
    }

    // 9. 广播实时数据
    wsHub.broadcast({
      type:        'tick',
      address,
      symbol:      state.symbol,
      price,
      fdv,
      lp:          state.lp,
      createdAt:   state.createdAt,
      rsi:         Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
      prevRsi:     Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
      signal,
      reason,
      closedCount: closedCandles.length,
      inPosition:  state.inPosition,
      volume:      displayVolume,
      tradeCount:  state.tradeCount,
      cooldown:    state._sellCooldownUntil > now ? Math.ceil((state._sellCooldownUntil - now) / 1000) : 0,
      dryRun:      DRY_RUN,
      ts:          now,
      birdeyeWs:   birdeye.priceStream.isConnected(),
      heliusWs:    heliusWs.isConnected(),
      heliusStats: heliusWs.getStats(),
    });

    logger.debug('[RSI] %s price=%.6f rsi=%.2f prev=%.2f signal=%s reason=%s trades=%d inPos=%s cool=%ds',
      state.symbol, price, rsi, prevRsi, signal || 'none', reason,
      state.tradeCount, state.inPosition,
      state._sellCooldownUntil > now ? Math.ceil((state._sellCooldownUntil - now) / 1000) : 0);

    // 10. 执行信号
    if (signal === 'BUY' && !state.inPosition && this._canBuy(state, now)) {
      // ★ 冷却通过后才标记 _lastBuyCandle，防止冷却期内白白消耗K线槽位
      {
        const lastCandle = signalCandleTs ?? (closedCandles && closedCandles.length > 0
          ? closedCandles[closedCandles.length - 1].openTime : -1);
        state._lastBuyCandle = lastCandle;
      }
      // ★ 买入前强制刷新 FDV（绕过缓存，确保数据最新）
      const freshFdv = await birdeye.getFdvFresh(address);
      if (freshFdv !== null && Number.isFinite(freshFdv) && freshFdv < FDV_EXIT) {
        logger.warn('[Monitor] %s 买入被拒: FDV=$%d < $%d', state.symbol, Math.round(freshFdv), FDV_EXIT);
      } else {
        state.fdv = freshFdv ?? state.fdv;  // 更新最新 FDV
        await this._doBuy(state, price, reason);
      }
    } else if (signal === 'SELL' && state.inPosition && !state._selling) {
      await this._doSell(state, reason);
    }
  }

  // ── 是否可以买入 ────────────────────────────────────────────────

  _canBuy(state, now) {
    // 已在持仓中
    if (state.inPosition) return false;
    // 正在卖出中
    if (state._selling) return false;
    // 冷却期中
    if (now < state._sellCooldownUntil) {
      logger.debug('[Monitor] %s 冷却中，还剩 %ds',
        state.symbol, Math.ceil((state._sellCooldownUntil - now) / 1000));
      return false;
    }
    return true;
  }

  // ── 买入 ────────────────────────────────────────────────────────

  async _doBuy(state, price, reason) {
    const tradeNum = state.tradeCount + 1;
    logger.info('[Monitor] 🟢 BUY #%d %s @ %.8f | %s | DRY_RUN=%s',
      tradeNum, state.symbol, price, reason, DRY_RUN);
    state.inPosition = true;
    // ★ FIX: 记录买入所在K线的开盘时间戳，供 checkVolumeDecay 做持仓保护期判断
    state._buyCandleTs = Math.floor(Date.now() / (KLINE_SEC * 1000)) * (KLINE_SEC * 1000);

    if (DRY_RUN) {
      const simulatedTokens = Math.floor(TRADE_SOL / price * 1e9);
      state.position = {
        entryPriceUsd : price,
        amountToken   : simulatedTokens,
        solIn         : TRADE_SOL,
        buyTxid       : `DRY_${Date.now()}`,
        buyTime       : Date.now(),
        buyReason     : reason,
        _peakPrice    : price,  // ★ 移动止损：初始峰值 = 买入价
      };
      state.tradeCount++;
      this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
        txid: state.position.buyTxid, solIn: TRADE_SOL, dryRun: true, tradeNum });
      await this._createTradeRecord(state);
      logger.info('[Monitor] ✅ DRY_RUN BUY #%d %s @ %.8f  solIn=%.4f',
        tradeNum, state.symbol, price, TRADE_SOL);
    } else {
      try {
        const result = await trader.buy(state.address, state.symbol);

        // ★ 买单成交后，等 500ms 再查一次实际成交价
        //   避免用"信号触发时价格"做止损基准（memecoin 滑点可能很大）
        let actualEntryPrice = price;
        try {
          await new Promise(r => setTimeout(r, 500));
          const postFillPrice = await birdeye.getPrice(state.address);
          if (postFillPrice && postFillPrice > 0) {
            actualEntryPrice = postFillPrice;
            if (Math.abs(postFillPrice - price) / price > 0.02) {
              logger.warn('[Monitor] ⚠️ BUY #%d %s 成交价偏差: 信号=%.6f 实际=%.6f (%.1f%%)',
                tradeNum, state.symbol, price, postFillPrice,
                (postFillPrice - price) / price * 100);
            }
          }
        } catch (_) { /* 查询失败保留信号价 */ }

        state.position = {
          entryPriceUsd : actualEntryPrice,  // ★ 用实际成交后价格，不用信号触发时价格
          signalPriceUsd: price,             // 保留信号价用于参考
          amountToken   : result.amountOut,
          solIn         : result.solIn,
          buyTxid       : result.txid,
          buyTime       : Date.now(),
          buyReason     : reason,
          _peakPrice    : actualEntryPrice,  // ★ 移动止损：初始峰值 = 实际成交价
        };
        state.tradeCount++;
        this._addTradeLog(state, { type: 'BUY', symbol: state.symbol,
          price: actualEntryPrice, signalPrice: price, reason,
          txid: result.txid, solIn: result.solIn, tradeNum });
        await this._createTradeRecord(state);
        logger.info('[Monitor] ✅ BUY #%d %s  solIn=%.4f SOL  entryPrice=%.6f  txid=%s',
          tradeNum, state.symbol, result.solIn, actualEntryPrice, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ BUY #%d %s 失败: %s', tradeNum, state.symbol, err.message);
        state.inPosition = false;
      }
    }
  }

  // ── 卖出（不再退出监控，重置状态等待下一轮） ────────────────────

  async _doSell(state, reason, opts = {}) {
    if (state._selling) return;  // 防并发

    // ★ V5-4: 同根K线禁卖保护 —— 买入所在K线内完全不允许卖出（包括止损）
    //   避免 K 线内价格噪声导致"买入→立即止损"同一根K线上下两个标记
    //   强制出场(removeToken / 手动移除)可通过 opts.force=true 绕过
    if (!opts.force && Number.isFinite(state._buyCandleTs) && state._buyCandleTs > 0) {
      const curCandleTs = Math.floor(Date.now() / (KLINE_SEC * 1000)) * (KLINE_SEC * 1000);
      if (curCandleTs === state._buyCandleTs) {
        // 只在首次阻止时打印，避免同根K线内反复触发刷屏
        const lastBlockLog = state._lastSameCandleBlockLog ?? 0;
        const now = Date.now();
        if (now - lastBlockLog > 5000) {
          state._lastSameCandleBlockLog = now;
          logger.info('[Monitor] 🛡 %s 同根K线买入保护,跳过卖出 | 原因: %s', state.symbol, reason);
        }
        return;
      }
    }

    state._selling = true;

    const isStopLoss = reason.includes('STOP_LOSS') || reason.includes('TAKE_PROFIT');
    const tradeNum = state.tradeCount;
    logger.info('[Monitor] 🔴 SELL #%d %s | %s | isStopLoss=%s | DRY_RUN=%s',
      tradeNum, state.symbol, reason, isStopLoss, DRY_RUN);

    if (DRY_RUN) {
      let currentPrice;
      try {
        currentPrice = await birdeye.getPrice(state.address);
      } catch (_) {
        currentPrice = state._lastPriceUsd
          || (state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : 0)
          || state.position?.entryPriceUsd || 0;
      }

      const solIn  = state.position?.solIn ?? TRADE_SOL;
      const entryP = state.position?.entryPriceUsd ?? 0;
      const solOut = entryP > 0 ? solIn * (currentPrice / entryP) : 0;
      const pnlPct = entryP > 0 ? (currentPrice - entryP) / entryP * 100 : 0;
      const pnlSol = solOut - solIn;

      state.inPosition = false;
      this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, reason,
        txid: `DRY_${Date.now()}`, solOut, pnlSol, dryRun: true, tradeNum });
      this._finalizeTradeRecord(state, reason, solOut, pnlPct);

      logger.info('[Monitor] ✅ DRY_RUN SELL #%d %s  solIn=%.4f  solOut=%.4f  pnl=%+.4f SOL (%+.1f%%)',
        tradeNum, state.symbol, solIn, solOut, pnlSol, pnlPct);
    } else {
      try {
        const result = await trader.sell(state.address, state.symbol, state.position, isStopLoss);
        const solOut  = result.solOut ?? 0;
        const solIn   = state.position?.solIn ?? TRADE_SOL;
        const pnlPct  = solIn > 0 ? (solOut - solIn) / solIn * 100 : 0;
        const pnlSol  = solOut - solIn;

        state.inPosition = false;
        this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, reason,
          txid: result.txid, solOut, pnlSol, elapsedMs: result.elapsedMs, tradeNum });
        this._finalizeTradeRecord(state, reason, solOut, pnlPct);

        logger.info('[Monitor] ✅ SELL #%d %s  solIn=%.4f  solOut=%.4f  pnl=%+.4f SOL (%+.1f%%)  耗时=%dms  txid=%s',
          tradeNum, state.symbol, solIn, solOut, pnlSol, pnlPct, result.elapsedMs || 0, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ SELL #%d %s 失败: %s', tradeNum, state.symbol, err.message);
        state.inPosition = false;
        this._finalizeTradeRecord(state, `SELL_FAILED(${reason})`, 0, -100);
      }
    }

    // ★ 重置状态，准备下一轮交易
    state._selling = false;
    state.position = null;

    // ★ 设置冷却期
    state._sellCooldownUntil = Date.now() + SELL_COOLDOWN_SEC * 1000;
    // 重置 RSI 穿越防抖（允许新的穿越信号）
    state._lastBuyCandle  = -1;
    state._lastSellCandle = -1;
    state._lastPanicSellTs = 0;
    state._lastRsiCrossSellTs = 0;  // ★ 重置实时RSI下穿防抖
    state._wsTickPrevRsi  = NaN;    // ★ 重置WS tick RSI历史
    state._slPollPrevRsi  = NaN;    // ★ 重置轮询RSI历史
    state._buyCandleTs   = 0;       // ★ FIX: 清除买入K线时间戳

    logger.info('[Monitor] 🔄 %s 第%d笔完成 | 冷却=%ds',
      state.symbol, tradeNum, SELL_COOLDOWN_SEC);
  }

  // ── 辅助工具 ────────────────────────────────────────────────────

  _addTradeLog(state, log) {
    state.tradeLogs.push({ ...log, ts: Date.now() });
    if (state.tradeLogs.length > 500) state.tradeLogs.shift();
    wsHub.broadcast({ type: 'trade_log', ...log, ts: Date.now() });
    this.emit('trade', log);
  }

  async _createTradeRecord(state) {
    if (!state.position) return;

    // ★ V5: 买入时优先用 FDV 缓存中的 LP（_fetchOverview 同时返回 fdv 和 lp）
    //   getFdvFresh 在 _doBuy 前已经调过了，缓存应该是热的
    let realTimeLp = state.lp;
    try {
      const cached = birdeye.getCachedFdv(state.address);
      // getCachedFdv只返回fdv，LP需要从overview缓存中取
      const lp = await birdeye.getLiquidity(state.address); // 会命中缓存
      if (lp !== null && Number.isFinite(lp)) {
        realTimeLp = lp;
        state.lp = lp;
      }
    } catch (_) {}

    const rec = {
      id:         `${state.address}_${state.tradeCount}_${Date.now()}`,
      address:    state.address,
      symbol:     state.symbol,
      tradeNum:   state.tradeCount,
      createdAt:  state.createdAt,  // ★ V5: 代币创建时间
      buyAt:      state.position.buyTime,
      buyTxid:    state.position.buyTxid,
      entryPrice: state.position.entryPriceUsd,
      entryFdv:   state.fdv,
      entryLp:    realTimeLp,
      solIn:      state.position.solIn,
      buyReason:  state.position.buyReason || '',
      dryRun:     DRY_RUN,
      exitAt:     null,
      exitReason: null,
      solOut:     null,
      pnlPct:    null,
      pnlSol:    null,
    };
    state.tradeRecords.push(rec);
    _allTradeRecords.unshift(rec);
    dataStore.appendTrade(rec);

    const cutoff = Date.now() - 24 * 3600 * 1000;
    while (_allTradeRecords.length && _allTradeRecords[_allTradeRecords.length - 1].buyAt < cutoff) {
      _allTradeRecords.pop();
    }
    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _finalizeTradeRecord(state, reason, solOut, pnlPct) {
    const rec = state.tradeRecords[state.tradeRecords.length - 1];
    if (!rec) return;
    rec.exitAt     = Date.now();
    rec.exitReason = reason;
    rec.solOut     = parseFloat(solOut.toFixed(6));
    rec.pnlPct    = parseFloat(pnlPct.toFixed(2));
    rec.pnlSol    = parseFloat((solOut - (state.position?.solIn ?? 0)).toFixed(6));

    dataStore.updateTrade(rec.id, {
      exitAt:     rec.exitAt,
      exitReason: rec.exitReason,
      solOut:     rec.solOut,
      pnlPct:    rec.pnlPct,
      pnlSol:    rec.pnlSol,
    });

    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _stateSnapshot(state) {
    const now = Date.now();
    return {
      address:      state.address,
      symbol:       state.symbol,
      addedAt:      state.addedAt,
      createdAt:    state.createdAt,
      inPosition:   state.inPosition,
      tradeCount:   state.tradeCount,
      cooldown:     state._sellCooldownUntil > now ? Math.ceil((state._sellCooldownUntil - now) / 1000) : 0,
      tradeLogs:    state.tradeLogs,
      tradeRecords: state.tradeRecords,
      dryRun:       DRY_RUN,
      lastPrice:    state._lastPriceUsd,
      lastPriceTs:  state._lastPriceTs,
      fdv:          state.fdv,
      lp:           state.lp,
      // ★ FIX: 带上最近一次计算的 RSI / 信号 / 量能，避免 token_list 广播时前端看不到数据
      price:        state._lastPriceUsd,
      rsi:          Number.isFinite(state._lastRsi)     ? state._lastRsi     : null,
      prevRsi:      Number.isFinite(state._lastPrevRsi) ? state._lastPrevRsi : null,
      signal:       state._lastSignal || null,
      reason:       state._lastReason || '',
      volume:       state._lastVolume || {},
      closedCount:  state._lastClosedCount ?? null,
    };
  }

  _broadcastTokenList() {
    wsHub.broadcast({ type: 'token_list', tokens: this.getTokens() });
  }

  // ── ★ V5: FDV/LP/Age 巡检（分散请求，每轮间隔 OVERVIEW_PATROL_SEC）──────

  _startOverviewPatrol() {
    // 启动后延迟5秒开始第一轮巡检（尽快拿到Age/FDV/LP数据）
    this._patrolTimer = setTimeout(() => this._runOverviewPatrol(), 5000);
  }

  async _runOverviewPatrol() {
    if (!this._started) return;
    const addresses = Array.from(this._tokens.keys());
    if (addresses.length === 0) {
      this._patrolTimer = setTimeout(() => this._runOverviewPatrol(), OVERVIEW_PATROL_SEC * 1000);
      return;
    }

    // 分散请求：每个币之间间隔 2 秒，95个币约3分钟完成一轮
    const INTERVAL_PER_TOKEN = 2000;
    logger.info('[Patrol] 开始 FDV/LP/Age 巡检，%d 个代币，预计 %ds',
      addresses.length, Math.ceil(addresses.length * INTERVAL_PER_TOKEN / 1000));

    for (let i = 0; i < addresses.length; i++) {
      if (!this._started) return;
      const address = addresses[i];
      const state = this._tokens.get(address);
      if (!state) continue;

      try {
        // ★ createdAt 为空时强制绕过缓存重新拉取（确保Age数据能拿到）
        if (!state.createdAt) birdeye.clearCache(address);
        const overview = await birdeye.getOverview(address);
        if (!overview) continue;

        // 更新 state
        if (overview.fdv !== null && Number.isFinite(overview.fdv)) state.fdv = overview.fdv;
        if (overview.liquidity !== null && Number.isFinite(overview.liquidity)) state.lp = overview.liquidity;
        if (overview.createdAt) state.createdAt = overview.createdAt; // ★ 始终更新，确保Age数据存在

        // ★ FDV 退出检查
        if (state.fdv !== null && Number.isFinite(state.fdv) && state.fdv < FDV_EXIT) {
          logger.warn('[Patrol] %s FDV=$%d < $%d，退出监控', state.symbol, Math.round(state.fdv), FDV_EXIT);
          await this.removeToken(address, `FDV_TOO_LOW($${Math.round(state.fdv)})`);
          continue;
        }

        // ★ LP 退出检查
        if (state.lp !== null && Number.isFinite(state.lp) && state.lp < LP_EXIT) {
          logger.warn('[Patrol] %s LP=$%d < $%d，退出监控', state.symbol, Math.round(state.lp), LP_EXIT);
          await this.removeToken(address, `LP_TOO_LOW($${Math.round(state.lp)})`);
          continue;
        }

        logger.debug('[Patrol] %s FDV=$%s LP=$%s age=%s',
          state.symbol,
          state.fdv ? Math.round(state.fdv) : '?',
          state.lp ? Math.round(state.lp) : '?',
          state.createdAt ? Math.round((Date.now() - state.createdAt) / 3600000) + 'h' : '?');
      } catch (err) {
        logger.warn('[Patrol] %s 巡检失败: %s', state.symbol, err.message);
      }

      // 等待间隔再查下一个
      if (i < addresses.length - 1) {
        await new Promise(r => setTimeout(r, INTERVAL_PER_TOKEN));
      }
    }

    logger.info('[Patrol] 巡检完成，下次 %ds 后', OVERVIEW_PATROL_SEC);
    this._patrolTimer = setTimeout(() => this._runOverviewPatrol(), OVERVIEW_PATROL_SEC * 1000);
  }

  // ── ★ FIX: 实时量能刷新（滑动窗口，不依赖K线聚合） ──────────
  //   窗口默认 VOL_WINDOW_SEC（秒），从 state.ticks 里的链上交易直接累加
  //   每次链上 tick 到达、或 _poll 每轮都会调用（带节流，避免高频扫描）
  //   force=true 时强制刷新（_poll 主路径调用时使用）
  _refreshLiveVolume(state, now, force = false) {
    // 节流：链上高频 tick 时，每 250ms 最多刷新一次；_poll 调用时 force=true 跳过节流
    if (!force && state._lastVolumeRefreshTs && (now - state._lastVolumeRefreshTs) < 250) {
      return;
    }
    state._lastVolumeRefreshTs = now;

    const windowMs = (parseInt(process.env.VOL_WINDOW_SEC || '300', 10)) * 1000;
    const cutoff = now - windowMs;
    let buyVol = 0, sellVol = 0, txCount = 0;
    // state.ticks 是按时间顺序追加的，从后往前扫直到超出窗口
    for (let i = state.ticks.length - 1; i >= 0; i--) {
      const t = state.ticks[i];
      if (t.ts < cutoff) break;
      if (t.source !== 'chain') continue;
      const amt = t.solAmount || 0;
      if (amt <= 0) continue;
      if (t.isBuy) buyVol += amt; else sellVol += amt;
      txCount++;
    }
    const total = buyVol + sellVol;
    state._lastVolume = {
      currentVol: total,
      buyVol, sellVol,
      buyRatio: total > 0 ? buyVol / total : 0,
      windowSec: windowMs / 1000,
      txCount,
      stale: false,
    };
  }

  // ── ★ V6: 监控数满时清理（按24h链上交易量(SOL)排序，清理量最小的）──────

  _evict24hVolume(state) {
    // 统计 state.ticks 中过去24小时的链上交易量(SOL)
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let vol = 0;
    for (const t of state.ticks) {
      if (t.source === 'chain' && t.ts >= cutoff && t.solAmount > 0) {
        vol += t.solAmount;
      }
    }
    return vol;
  }

  _evictForNewToken() {
    if (this._tokens.size < MAX_TOKENS) return true; // 有空位

    // 按24h链上交易量升序排，量最小的（最不活跃）优先被清理
    const candidates = Array.from(this._tokens.values())
      .filter(s => !s.inPosition && !s._selling)  // 不清理持仓中的
      .map(s => ({ state: s, vol24h: this._evict24hVolume(s) }))
      .sort((a, b) => a.vol24h - b.vol24h);  // 交易量最小的排前面

    if (candidates.length === 0) {
      logger.warn('[Monitor] 监控已满(%d/%d)且所有代币都持仓中，无法清理', this._tokens.size, MAX_TOKENS);
      return false;
    }

    const { state: victim, vol24h } = candidates[0];
    logger.info('[Monitor] 🧹 监控已满(%d/%d)，清理24h量最低代币 %s（%.2f SOL）',
      this._tokens.size, MAX_TOKENS, victim.symbol, vol24h);
    this.removeToken(victim.address, `EVICTED(vol24h=${vol24h.toFixed(2)}SOL)`);
    return true;
  }
}

function getAllTradeRecords() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const memRecords = _allTradeRecords.filter(r => r.buyAt > cutoff);
  if (memRecords.length === 0) {
    return dataStore.loadTrades().filter(r => r.buyAt > cutoff);
  }
  return memRecords;
}

const monitor = new TokenMonitor();
module.exports = monitor;
module.exports.getAllTradeRecords = getAllTradeRecords;
module.exports.DRY_RUN = DRY_RUN;
