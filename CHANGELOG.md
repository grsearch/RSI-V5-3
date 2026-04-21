# CHANGELOG — RSI-V5-2 修复

## V6 修复(本次)— 彻底终结 "RSI 异常跳跃导致的假下穿/假恐慌"

### 现象

CAPTCHA 币再次出问题:
- 买入后同一根 K 线卖出
- 卖出理由:`RSI下穿70 K:78.8→31.8`
- 图上观察:RSI 实际在 50~65 之间波动,**从未到过 78,更没从 78 骤降到 31**

**单根 K 线之间 RSI 变化 47 个点 —— 这是不可能的正常波动,纯粹是脏数据。**

### V5 修复为何没挡住?

V5 只加了"历史 K 线和实时 K 线拼接处价格跳跃 > 15% 禁用历史"。但:

1. **CAPTCHA 的跳跃可能只有 10~15%**,没到 15% 阈值
2. **历史 K 线内部自己**就有跳跃点(Birdeye 返回的数据本身不连续),V5 没检查这种情况
3. **RSI 缓存污染**:一旦某次计算出脏值,`state._rsiAvgGain/AvgLoss` 被 Wilder 增量更新后带进去,**即使禁用历史 K 线也洗不掉**

### V6 的 6 层防御

#### 层 1:历史 K 线入口 sanity check(最前置防御)

Birdeye 拉取的历史 K 线,在**赋值给 `state.historicalCandles` 之前**扫描一遍:

- 相邻 K 线 `open` 和 `close` 价格跳跃 > 10% → 从这一点往旧丢弃
- K 线内部 `(high-low)/low > 50%` → 这根 K 线本身就不可信,丢弃及更旧的
- 清洗后不足 20 根 → 全部丢弃,等实时 K 线自然累积

```
[Monitor] CAPTCHA 历史K线内部价格跳跃(18.5% at idx=45),丢弃前 45 根,保留后 115 根
```

#### 层 2:历史/实时拼接处检查(V5 已有,阈值从 15% → 10%)

```
[Monitor] CAPTCHA 历史K线和实时K线拼接处价格跳跃过大(12.3%),仅使用实时K线
```

#### 层 3:RSI 相邻值跳跃保护(核心修复)

所有 4 条 RSI 下穿 70 路径(`evaluateSignal`、`_checkRealtimeRsiSell`、`_stopLossPoll`RT、`_stopLossPoll`K线)全部加:

- 如果 `|prev - cur| > 30` → **拒绝触发卖出**,同时设 `state._rsiDataTainted = true`
- RSI(7) 正常一次 tick 的变化应该 < 5,一根 K 线的变化应该 < 15,**> 30 一定是脏数据**

```
[Monitor] CAPTCHA RSI相邻K线跳跃异常(78.8→31.8,差47.0),跳过下穿70判定
```

#### 层 4:脏数据标记传播 + 自动清缓存

任何一条路径检测到脏数据会设 `state._rsiDataTainted`,`_poll` 下一次循环会:

- 禁用 `historicalCandles`
- **清空所有 RSI 缓存**: `_rsiAvgGain`、`_rsiAvgLoss`、`_rsiLastClose`、`_slPollPrevRsi`、`_wsTickPrevRsi`、`_prevRsiRealtime`
- 强制从纯实时 K 线重算 RSI

```
[Monitor] CAPTCHA RSI数据被标记污染,已禁用历史K线并清空RSI缓存
```

#### 层 5:RSI_PANIC 连续 2 根确认(V5 已有,无改动)

`lastClosedRsi > 80` 且 `prevClosedRsi > 80` 才触发,单根虚高不触发。

#### 层 6:量能萎缩出场买入保护(V5 已有,无改动)

`VOL_EXIT_MIN_HOLD_CANDLES=2`,买入后至少持仓 2 根 K 线。

### 🔧 本次修改文件

| 文件 | 改动 |
|---|---|
| `src/monitor.js` | 新增 `_sanitizeHistoricalCandles` 函数、2 处调用;`_poll` 响应 `_rsiDataTainted` 清缓存、拼接阈值 15%→10%、加历史K线内部跳跃检查;4 条 RSI 下穿路径全加跳跃保护 |
| `src/rsi.js` | `evaluateSignal` RSI 下穿 70 加跳跃保护 |

### 部署后验证

启动日志应出现(如果 Birdeye 历史数据有问题):

```
[Monitor] CAPTCHA 历史K线内部价格跳跃(15.2% at idx=47),丢弃前 47 根,保留后 113 根
[Monitor] CAPTCHA 历史K线预热: 113/160 根 (EMA99/RSI立即可用)
```

或者(历史整体不可用):

```
[Monitor] XYZ 历史K线清洗后仅余 8 根(不足20根),全部丢弃,等实时K线累积
[Monitor] XYZ 历史K线全部不可信,不加载历史,等实时K线累积
```

正常运行时应该**不再出现** `RSI_CROSS_DOWN_70 K:78.8→31.8` 这种异常的卖出日志。

---

## V5 修复 — 买入即卖 + RSI 恐慌误报

详见前版 CHANGELOG。量能萎缩参数合理化、买入保护期、RSI_PANIC 连续确认、历史K线拼接处价格连续性检查(初版)。

## V4 修复 — 量能方向判断错误 + 95 币动态订阅

详见前版 CHANGELOG。用交易签名者做方向锚点、过滤多跳路由、先建新后取消旧订阅。

## V3 修复 — Helius 订阅确认慢

详见前版 CHANGELOG。强制批量订阅、修复防抖无限重置、加重试。

## V2 修复 — 量能虚高

详见前版 CHANGELOG。修 WSOL `Math.abs` 累加放大。

## V1 修复 — Buy/Sell 显示 `-`

详见前版 CHANGELOG。

---

## 部署

```bash
git pull
npm install --omit=dev
sudo systemctl restart sol-rsi-monitor

# 监控关键日志
journalctl -u sol-rsi-monitor -f | grep -E "BUY|SELL|RSI跳跃|RSI数据被标记|历史K线|RSI异常高值"
```

## 95 币场景推荐完整 .env

```bash
KLINE_INTERVAL_SEC=300
RSI_PERIOD=7
RSI_BUY_LEVEL=30
RSI_SELL_LEVEL=70
RSI_PANIC_LEVEL=80

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
