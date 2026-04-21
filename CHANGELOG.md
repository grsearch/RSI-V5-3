# CHANGELOG — RSI-V5-2 修复

## V7 修复(本次)— EMA99 过滤器静默失效(严重 bug)

### 现象

Patapim 币买入点 B(~16:00,价格 ~248K),当时价格**明显高于 EMA99 蓝色线(~220K)**,按策略应该被拒绝买入,但程序仍然买了。

### 根本原因(3 个关联 bug)

#### ① `calcEMA` 在 K 线不足时返回 NaN

```javascript
function calcEMA(closes, period) {
  if (closes.length < period) return NaN;  // ← K线 < 99 就返回 NaN
  ...
}
```

#### ② 调用方用 `Number.isFinite(ema99) &&` 短路

```javascript
if (Number.isFinite(ema99) && realtimePrice >= ema99) {
  // 拒绝买入
}
```

当 `ema99 = NaN`:
- `Number.isFinite(NaN) === false`
- 整个 `if` 直接跳过 → **不拒绝** → 程序往下走,买入

#### ③ 实战中 K 线经常不足 99 根

- 新加入监控的币,实时 K 线可能只有几十根
- V5/V6 修复里,历史 K 线被检测为不连续时会被丢弃,剩下的 K 线就更少
- 结果:**EMA99 过滤器在大量场景下完全失效**,所有买入都是在没做 EMA99 过滤的情况下触发的

### 🔧 本次修复

#### `src/rsi.js`

**1. `calcEMA` 支持 K 线不足时返回近似值**

```javascript
function calcEMA(closes, period) {
  const MIN_BARS_FOR_APPROX = 20;
  if (!closes || closes.length < MIN_BARS_FOR_APPROX) return NaN;

  if (closes.length >= period) {
    // 标准 EMA 计算(不变)
    ...
  }

  // ★ K线不足 period 根,用"可用根数"作为 effectivePeriod 计算短期 EMA
  const effectivePeriod = closes.length;
  ...
}
```

**2. `evaluateSignal` 里拒买条件更严格**

```javascript
const EMA_STRICT_MIN_BARS = parseInt(process.env.EMA_STRICT_MIN_BARS || '30', 10);
const ema99 = calcEMA(closes, EMA_PERIOD);

// K线少于 30 根,EMA 完全不可信,保守拒买
if (closes.length < EMA_STRICT_MIN_BARS) {
  return { signal: null, reason: `EMA99_WARMING_UP(candles=${closes.length}<${EMA_STRICT_MIN_BARS})` };
}
// EMA 计算异常
if (!Number.isFinite(ema99)) {
  return { signal: null, reason: `EMA99_NAN` };
}
// 价格 >= EMA99 拒买
if (realtimePrice >= ema99) {
  return { signal: null, reason: `PRICE_ABOVE_EMA99(price=...,ema99=...,candles=...)` };
}
```

**3. 买入成功时 reason 附带 EMA99 数值**

```
RSI_OVERSOLD(28.5<30)+EMA99OK(0.00001234<0.00001500)+BUY≥1.2xSELL(...)
```

方便事后核对:日志里明明白白告诉你当时价格和 EMA99 是多少。

### 新增 .env 参数

```bash
EMA_STRICT_MIN_BARS=30     # 最少 30 根 K 线(5分钟 = 2.5 小时)才允许买入
                           # 不够就拒绝,等 K 线自然累积
```

### 效果验证

部署后观察日志,新加入的币应该看到:

```
[RSI] TOKEN signal=none reason=EMA99_WARMING_UP(candles=15<30)
[RSI] TOKEN signal=none reason=EMA99_WARMING_UP(candles=25<30)
...(K线累积到30+后)
[RSI] TOKEN signal=none reason=PRICE_ABOVE_EMA99(price=0.00005,ema99=0.00003,candles=45)
...(价格跌到 EMA99 下方 + RSI 超卖 + 量能 OK)
[Monitor] 🟢 BUY TOKEN @ ... | RSI_OVERSOLD(28.5<30)+EMA99OK(0.00003<0.00004)+...
```

**所有买入理由里现在都能看到"price < ema99",之前那种 silently bypass 的情况不会再发生。**

### 对策略的影响

- **新币加入后前 2.5 小时(30根5分钟K线)不会买入** —— 这是保守的选择,权衡"错过早期机会" vs "未经EMA99过滤的盲买"
- 如果你想激进一点,可以把 `EMA_STRICT_MIN_BARS` 调低到 `20`,或 `15`
- 如果想完全禁用 EMA99 过滤,把 `EMA_STRICT_MIN_BARS=0`(不推荐,你刚买入 Patapim 就是这样亏的)

### 可选:调整 EMA 周期

99 期 EMA 对 5 分钟 K 线是很长的(99 × 5 = 495 分钟 = 8.25 小时),对 memecoin 可能太慢。可以考虑:

```bash
EMA_PERIOD=20    # EMA20: 快很多,100 分钟均线
# 或
EMA_PERIOD=50    # EMA50: 4 小时均线
```

但调整前请用历史回测验证,不要盲改。

---

## 历史修复

- **V6**: RSI 异常跳跃防御(6 层检测 + 脏数据自动清缓存)
- **V5**: 买入即卖(量能萎缩参数)+ RSI 恐慌误报
- **V4**: 量能方向判断错(签名者做锚点)+ 95 币动态订阅
- **V3**: Helius 订阅确认慢(强制批量订阅)
- **V2**: 量能虚高(WSOL `Math.abs` 累加)
- **V1**: Buy/Sell 显示 `-`

---

## 部署

```bash
git pull
npm install --omit=dev
sudo systemctl restart sol-rsi-monitor

# 监控 EMA99 过滤日志
journalctl -u sol-rsi-monitor -f | grep -E "BUY|SELL|EMA99|WARMING_UP|PRICE_ABOVE"
```

## 95 币场景推荐完整 .env

```bash
KLINE_INTERVAL_SEC=300
RSI_PERIOD=7
RSI_BUY_LEVEL=30
RSI_SELL_LEVEL=70
RSI_PANIC_LEVEL=80

EMA_PERIOD=99
EMA_STRICT_MIN_BARS=30        # ★ V7 新增:K线不足时拒买

VOL_ENABLED=true
VOL_BUY_MULT=1.2
VOL_MIN_TOTAL=5
VOL_WINDOW_SEC=300

VOL_EXIT_RATIO=0.3
VOL_EXIT_LOOKBACK=6
VOL_EXIT_CONSECUTIVE=3
VOL_EXIT_MIN_HOLD_CANDLES=2

TAKE_PROFIT_PCT=50
STOP_LOSS_PCT=-20
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ACTIVATE=30
TRAILING_STOP_PCT=-20

HELIUS_BATCH_THRESHOLD=0
HELIUS_CHUNK_SIZE=50

MAX_MONITOR_TOKENS=95
FDV_EXIT_USD=30000
LP_EXIT_USD=10000
OVERVIEW_PATROL_SEC=7200
SELL_COOLDOWN_SEC=1800

DRY_RUN_DATA_DIR=/root/sol-monitor-data
```
