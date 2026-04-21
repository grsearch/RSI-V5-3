# CHANGELOG — RSI-V5-2 修复

## V5 修复(本次)— 买入即卖 + RSI 恐慌误报

### 三个现象

| 币 | 现象 | 实际 K 线情况 |
|---|---|---|
| SOMETHING (图1) | 买入同一根K线就卖出,理由"量能萎缩" | 卖得莫名其妙 |
| BELIEF (图2) | 买入同一根K线就卖出,理由"量能萎缩" | 卖得莫名其妙 |
| CAPTCHA (图3) | 卖出理由"RSI恐慌 97.6>80" | 实际 RSI 只有 61,图上没出现过 97.6 |
| DUMBMONEY (图4) | 卖出理由"RSI下穿70 RT:71.3→68.6" | 正常,按设计工作 ✅ |

### 根本原因

#### ① 量能萎缩参数过于激进(问题 1)

```
VOL_EXIT_RATIO = 1.0       # 阈值 = 平均 × 1.0(略低就触发)
VOL_EXIT_LOOKBACK = 4      # 取前 4 根平均
VOL_EXIT_CONSECUTIVE = 2   # 最近 2 根都 < 阈值触发
```

买入信号是 **RSI 超卖 + 量能放大** 的结果,**买入那一刻通常就是量能爆发的峰值**。买入后那根 K 线自然会回落,"平均 × 1.0" 的门槛几乎必然在买入后 1-2 根 K 线内被触发。

**导致每次买入后几乎立即被"量能萎缩"踢出场,策略完全跑不起来。**

#### ② 历史 K 线和实时 K 线拼接处价格跳跃,污染 RSI(问题 2)

代码在 `_poll` 里:
```javascript
closedCandles = [...histFiltered, ...liveClosed];
```

`historicalCandles` 是 Birdeye API 拉的历史 K 线,`liveClosed` 是监控启动后自己聚合的实时 K 线。如果两者**时间边界**两根 K 线的价格差距大(比如历史最后一根 close=68K,实时第一根 open=81K),RSI(7) 会在这个跳跃点算出虚假高值 95+。

**CAPTCHA 正好碰上:21 号早上价格从 81K 暴跌到 68K 再反弹到 81K。** Birdeye 历史 K 线可能捕获了跌点,实时 K 线从反弹后开始,拼接处就是 +19% 的假 K 线。

**更糟**:这个虚假高 RSI 会被 `calcRSIWithState` 的 `avgGain/avgLoss` 缓存到 `state` 上,之后所有实时 RSI 计算都基于脏数据。

### 🔧 修复清单

#### `src/rsi.js`

1. **量能萎缩参数合理化**
   - `VOL_EXIT_RATIO`: `1.0` → `0.3`(真正萎缩到平均的 30% 才触发)
   - `VOL_EXIT_LOOKBACK`: `4` → `6`(平均基线更稳)
   - `VOL_EXIT_CONSECUTIVE`: `2` → `3`(连续 3 根才触发)

2. **新增买入后保护期**
   - 新参数 `VOL_EXIT_MIN_HOLD_CANDLES=2`:买入后至少持有 2 根 K 线,才允许量能萎缩出场
   - `checkVolumeDecay` 通过 `tokenState._buyCandleTs` 计算已持仓 K 线数,不满足保护期返回 `HOLD_PROTECTION`

3. **RSI_PANIC 要求连续 2 根确认**
   - 原来:`lastClosedRsi > 80` 单根就触发
   - 现在:`lastClosedRsi > 80` **且** `prevClosedRsi > 80` 才触发
   - 单根虚高(数据不连续导致的)不再误触发,日志会记录 `RSI异常高值不触发恐慌`

#### `src/monitor.js`

4. **历史 K 线拼接价格连续性检查**
   - `_poll` 和 `_stopLossPoll` 拼接 `historicalCandles + liveCandles` 前,比较历史最后一根 close 和实时第一根 open
   - 跳跃 > 15% → **丢弃历史 K 线**,只用实时数据(设 `state._historicalCandlesDisabled`)
   - 打日志提醒:`历史K线和实时K线拼接处价格跳跃过大(XX%),仅使用实时K线`

5. **`_doBuy` 记录买入 K 线时间戳**
   - `state._buyCandleTs = Math.floor(Date.now() / (KLINE_SEC * 1000)) * (KLINE_SEC * 1000)`
   - `_doSell` 清理该字段

6. **`_stopLossPoll` RSI_PANIC 也加连续确认**

### 参数说明

新增/修改的 `.env` 参数:

```bash
# 量能萎缩出场(全部放宽,避免买入即卖)
VOL_EXIT_RATIO=0.3              # 低于平均 30% 才触发(原 1.0)
VOL_EXIT_LOOKBACK=6             # 取前 6 根平均(原 4)
VOL_EXIT_CONSECUTIVE=3          # 连续 3 根萎缩(原 2)
VOL_EXIT_MIN_HOLD_CANDLES=2     # 新增:买入后至少持有2根K线(5分钟K线=10分钟)

# 其他保持不变
RSI_PANIC_LEVEL=80              # 恐慌阈值
VOL_WINDOW_SEC=300              # 量能窗口
HELIUS_CHUNK_SIZE=50            # 批量订阅块大小
```

### 如果你想更激进或更保守

- **更激进(想更快止盈出场)**:`VOL_EXIT_MIN_HOLD_CANDLES=1`, `VOL_EXIT_RATIO=0.5`
- **更保守(宁可多持仓)**:`VOL_EXIT_MIN_HOLD_CANDLES=3`, `VOL_EXIT_RATIO=0.2`
- **彻底禁用量能萎缩**:`.env` 里 `VOL_ENABLED=false`(也会禁用买入量能过滤,慎用)
- **只禁用量能萎缩出场**:改不了,但 `VOL_EXIT_RATIO=0` 可等效禁用(永不触发)

### 验证修复效果

启动后日志里应该看到:
```
[Monitor] 🟢 BUY #1 TOKEN @ 0.00001234 | RSI_OVERSOLD(28.5<30)+EMA99OK+BUY≥1.2xSELL(...)
... (持仓至少 2 根K线,期间看到 HOLD_PROTECTION)
[Monitor] 🔴 SELL #1 TOKEN @ ... | RSI_CROSS_DOWN_70(...)  ← 由 RSI 下穿触发,不再是买入即卖
```

如果历史 K 线异常:
```
[Monitor] CAPTCHA 历史K线和实时K线拼接处价格跳跃过大(19.1%),仅使用实时K线
```

如果单根 RSI 虚高:
```
[Monitor] CAPTCHA RSI异常高值不触发恐慌 last=97.6 prev=61.2 (需连续2根>80)
```

---

## V4 修复 — 量能方向判断错误 + 95 币动态订阅管理

详见前版 CHANGELOG。核心:用交易签名者(fee payer)做方向锚点、过滤多跳路由、先建新后取消旧订阅。

## V3 修复 — Helius 订阅确认慢

详见前版 CHANGELOG。核心:BATCH_THRESHOLD=0 强制批量订阅、修复防抖无限重置、加块超时重试。

## V2 修复 — 量能虚高

详见前版 CHANGELOG。修 WSOL `Math.abs` 累加放大。

## V1 修复 — Buy/Sell 显示 `-`

详见前版 CHANGELOG。修前端 `handleTokenList`、后端 `_stateSnapshot` 等数据流。

---

## 部署

```bash
git pull
npm install --omit=dev
sudo systemctl restart sol-rsi-monitor

# 关键日志监控
journalctl -u sol-rsi-monitor -f | grep -E "BUY|SELL|VOL_DECAY|RSI_PANIC|HOLD_PROTECTION|历史K线|异常高值"
```

## 95 币场景推荐完整配置

```bash
# .env
KLINE_INTERVAL_SEC=300          # 5 分钟 K 线
RSI_PERIOD=7
RSI_BUY_LEVEL=30
RSI_SELL_LEVEL=70
RSI_PANIC_LEVEL=80

# 买入量能
VOL_ENABLED=true
VOL_BUY_MULT=1.2
VOL_MIN_TOTAL=5
VOL_WINDOW_SEC=300

# 量能萎缩出场(V5 修复后的合理值)
VOL_EXIT_RATIO=0.3
VOL_EXIT_LOOKBACK=6
VOL_EXIT_CONSECUTIVE=3
VOL_EXIT_MIN_HOLD_CANDLES=2

# 止盈止损
TAKE_PROFIT_PCT=50
STOP_LOSS_PCT=-20
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ACTIVATE=30
TRAILING_STOP_PCT=-20

# Helius
HELIUS_BATCH_THRESHOLD=0        # 永远批量订阅
HELIUS_CHUNK_SIZE=50            # 50/块

# 监控管理
MAX_MONITOR_TOKENS=95
FDV_EXIT_USD=30000
LP_EXIT_USD=10000
OVERVIEW_PATROL_SEC=7200
SELL_COOLDOWN_SEC=1800

# 数据目录(项目外,更新代码不丢失)
DRY_RUN_DATA_DIR=/root/sol-monitor-data
```
