'use strict';
// src/heliusWs.js — Helius Enhanced WebSocket 链上交易监听 V5
//
// 订阅策略（统一支持所有 AMM：Pump/Raydium/Meteora/Orca）：
//
//   代币数 ≤ BATCH_THRESHOLD（默认30）→ 独立订阅（每个 token 一个 subscription）
//   代币数 > BATCH_THRESHOLD         → 批量订阅（所有 mint 放入一个 accountInclude 数组）
//
//   已彻底移除 pump 模式（只支持 Pump AMM，不适合混合 AMM 场景）。

const WebSocket = require('ws');
const logger    = require('./logger');

const HELIUS_WSS_URL        = process.env.HELIUS_WSS_URL || '';
const HELIUS_GATEKEEPER_URL = process.env.HELIUS_GATEKEEPER_URL || '';
const HELIUS_API_KEY        = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL        = process.env.HELIUS_RPC_URL || '';

// 超过此数量时改用批量订阅。★ 默认 0 = 永远用批量订阅
// Helius 单 WebSocket 连接对 transactionSubscribe 有订阅槽位隐式限制(~50)
// 独立订阅每个币占一槽，数量多会导致确认超慢甚至丢失，批量订阅合并后只占少量槽
const BATCH_THRESHOLD = parseInt(process.env.HELIUS_BATCH_THRESHOLD || '0', 10);

const LAMPORTS     = 1e9;
const PING_MS      = 25000;
const RECONNECT_MS = 2000;
const MAX_RETRIES  = 999;

function getWsUrl() {
  if (HELIUS_GATEKEEPER_URL) {
    let url = HELIUS_GATEKEEPER_URL;
    if (url.startsWith('https://')) url = url.replace('https://', 'wss://');
    if (!url.startsWith('wss://')) url = 'wss://' + url;
    return { url, type: 'gatekeeper' };
  }
  if (HELIUS_WSS_URL) return { url: HELIUS_WSS_URL, type: 'enhanced' };
  const apiKey = HELIUS_API_KEY || extractApiKey(HELIUS_RPC_URL);
  if (!apiKey) return { url: '', type: 'none' };
  return { url: 'wss://mainnet.helius-rpc.com/?api-key=' + apiKey, type: 'enhanced' };
}

function extractApiKey(rpcUrl) {
  const m = (rpcUrl || '').match(/api-key=([a-f0-9-]+)/i);
  return m ? m[1] : '';
}

class HeliusTradeStream {
  constructor() {
    this._ws          = null;
    this._pingTimer   = null;
    this._statsTimer  = null;
    this._connected   = false;
    this._retryCount  = 0;
    this._connType    = 'none';
    this._tokens      = new Map(); // address → { symbol, onTrade, subId }
    this._pendingSubs = new Map(); // rpcId → address | '__batch__'
    this._nextRpcId   = 100;
    this._batchSubIds   = [];
    this._batchSubId    = null;
    this._batchDebounce    = null;
    this._batchTimeoutTimer = null;
    this._CHUNK_SIZE        = parseInt(process.env.HELIUS_CHUNK_SIZE || '50', 10);
    this._stats = { txReceived: 0, txMatched: 0, txParsed: 0, txSkipped: 0, connType: 'none' };
  }

  start() {
    const { url, type } = getWsUrl();
    if (!url) {
      logger.warn('[HeliusWS] 未配置 Helius WebSocket URL，链上量能数据不可用');
      return;
    }
    this._connType = type;
    this._stats.connType = type;
    logger.info(`[HeliusWS] 启动 | 批量订阅阈值=${BATCH_THRESHOLD}`);
    this._connect(url);
  }

  stop() {
    this._connected = false;
    this._retryCount = MAX_RETRIES + 1;
    if (this._pingTimer)  { clearInterval(this._pingTimer);  this._pingTimer  = null; }
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
  }

  _connect(wsUrl) {
    const safeUrl = wsUrl.replace(/api-key=[a-f0-9-]+/i, 'api-key=***');
    logger.info('[HeliusWS] 连接 %s ...', safeUrl);

    if (!this._statsTimer) {
      this._statsTimer = setInterval(() => {
        const s = this.getStats();
        logger.info(`[HeliusWS] 状态: tokens=${s.tokens} subMode=${s.subMode} batchSubId=${s.batchSubId||'none'} txReceived=${s.txReceived} txMatched=${s.txMatched} txParsed=${s.txParsed}`);
      }, 60000);
    }

    this._ws = new WebSocket(wsUrl);

    this._ws.on('open', () => {
      logger.info('[HeliusWS] ✅ 已连接 (%s)', this._connType);
      this._connected  = true;
      this._retryCount = 0;
      this._batchSubId  = null;
      this._batchSubIds = [];

      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.ping();
      }, PING_MS);

      this._resubscribeAll();
    });

    this._ws.on('message', (data) => this._handleMessage(data));
    this._ws.on('pong', () => {});
    this._ws.on('error', (err) => logger.error(`[HeliusWS] 错误: ${err.message}`));

    this._ws.on('close', () => {
      logger.warn('[HeliusWS] 连接关闭');
      this._connected  = false;
      this._batchSubId  = null;
      this._batchSubIds = [];
      this._pendingSubs.clear();
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }

      if (this._retryCount < MAX_RETRIES) {
        this._retryCount++;
        const delay = Math.min(RECONNECT_MS * Math.pow(1.5, this._retryCount - 1), 30000);
        logger.info(`[HeliusWS] ${(delay/1000).toFixed(0)}s 后重连 (第${this._retryCount}次)`);
        setTimeout(() => {
          const { url } = getWsUrl();
          if (url) this._connect(url);
        }, delay);
      }
    });
  }

  _resubscribeAll() {
    if (this._tokens.size === 0) return;
    for (const info of this._tokens.values()) info.subId = null;

    // ★ FIX: 重连后统一走批量订阅，不再按 BATCH_THRESHOLD 判断
    //   因为独立订阅会撞 Helius 单连接订阅槽位限制(~50)
    setTimeout(() => this._subscribeBatch(), 500);
  }

  _subscribeToken(tokenAddress) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const rpcId = this._nextRpcId++;
    this._pendingSubs.set(rpcId, tokenAddress);
    this._ws.send(JSON.stringify({
      jsonrpc: '2.0', id: rpcId,
      method: 'transactionSubscribe',
      params: [
        { accountInclude: [tokenAddress], failed: false },
        { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
      ],
    }));
    const info = this._tokens.get(tokenAddress);
    logger.debug(`[HeliusWS] 独立订阅 ${(info && info.symbol) || tokenAddress.slice(0,8)}`);
  }

  _unsubscribeToken(tokenAddress) {
    const info = this._tokens.get(tokenAddress);
    if (!info || !info.subId) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        jsonrpc: '2.0', id: this._nextRpcId++,
        method: 'transactionUnsubscribe',
        params: [info.subId],
      }));
    }
    info.subId = null;
  }

  _subscribeBatch() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const addresses = Array.from(this._tokens.keys());
    if (addresses.length === 0) return;

    // ★ FIX: 保存旧订阅,等新订阅确认后再取消,避免订阅空窗期丢交易
    const oldBatchSubIds = this._batchSubIds.slice();
    const oldTokenSubs = [];
    for (const [addr, info] of this._tokens.entries()) {
      if (info.subId) oldTokenSubs.push({ addr, subId: info.subId });
    }

    // 先重置当前激活订阅记录（旧的作为"待取消"保存）
    this._batchSubIds = [];
    this._batchSubId  = null;

    // 分块
    const chunks = [];
    for (let i = 0; i < addresses.length; i += this._CHUNK_SIZE) {
      chunks.push(addresses.slice(i, i + this._CHUNK_SIZE));
    }

    logger.info(`[HeliusWS] 📡 批量订阅 ${addresses.length} 个 token，分 ${chunks.length} 块 (每块 ${this._CHUNK_SIZE})` +
      (oldBatchSubIds.length > 0 ? ` [旧订阅 ${oldBatchSubIds.length} 块待切换]` : ''));

    this._pendingBatchChunks = new Map(); // rpcId → { chunk, retry, sentAt, idx }

    // ★ FIX: 先发送新订阅
    chunks.forEach((chunk, idx) => {
      setTimeout(() => {
        if (!this._connected || this._ws.readyState !== WebSocket.OPEN) return;
        this._sendBatchChunk(chunk, idx, 0);
      }, idx * 200);
    });

    // ★ FIX: 延迟取消旧订阅 —— 等新订阅有机会确认
    //   策略：至少等 3 秒 + 最后一块发送时间，确保大部分新块已确认
    const cancelDelay = 3000 + chunks.length * 200;
    if (oldBatchSubIds.length > 0 || oldTokenSubs.length > 0) {
      setTimeout(() => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        for (const oldSubId of oldBatchSubIds) {
          this._ws.send(JSON.stringify({
            jsonrpc: '2.0', id: this._nextRpcId++,
            method: 'transactionUnsubscribe',
            params: [oldSubId],
          }));
        }
        for (const o of oldTokenSubs) {
          this._ws.send(JSON.stringify({
            jsonrpc: '2.0', id: this._nextRpcId++,
            method: 'transactionUnsubscribe',
            params: [o.subId],
          }));
        }
        logger.info(`[HeliusWS] 🔕 旧订阅已取消 (batch=${oldBatchSubIds.length}, individual=${oldTokenSubs.length})`);
      }, cancelDelay);
    }

    // 超时降级检测
    clearTimeout(this._batchTimeoutTimer);
    this._batchTimeoutTimer = setTimeout(() => {
      const unconfirmed = [];
      for (const [, info] of this._pendingBatchChunks || []) {
        for (const addr of info.chunk) unconfirmed.push(addr);
      }
      if (unconfirmed.length > 0 && this._batchSubIds.length === 0 && this._connected) {
        logger.warn(`[HeliusWS] ⚠️ 批量订阅 15s 内无任何确认，降级到独立订阅`);
        this._fallbackToIndividual();
      } else if (unconfirmed.length > 0) {
        logger.warn(`[HeliusWS] ⚠️ 部分块未确认 (${unconfirmed.length} 个 token)，重试中`);
      }
    }, 15000);
  }

  // ★ FIX: 发送单个块 + 自动重试
  _sendBatchChunk(chunk, idx, retry) {
    if (!this._connected || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const rpcId = this._nextRpcId++;
    this._pendingSubs.set(rpcId, `__batch_${idx}_${retry}__`);
    if (!this._pendingBatchChunks) this._pendingBatchChunks = new Map();
    this._pendingBatchChunks.set(rpcId, { chunk, retry, sentAt: Date.now(), idx });

    this._ws.send(JSON.stringify({
      jsonrpc: '2.0', id: rpcId,
      method: 'transactionSubscribe',
      params: [
        { accountInclude: chunk, failed: false },
        { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
      ],
    }));
    logger.info(`[HeliusWS] 📡 块[${idx}] ${chunk.length} token rpcId=${rpcId} retry=${retry}`);

    // 单块 10 秒未确认就重试，最多 3 次
    setTimeout(() => {
      if (this._pendingBatchChunks && this._pendingBatchChunks.has(rpcId)) {
        this._pendingBatchChunks.delete(rpcId);
        this._pendingSubs.delete(rpcId);
        if (retry < 3 && this._connected) {
          logger.warn(`[HeliusWS] ⏱ 块[${idx}] rpcId=${rpcId} 超时未确认，重试 ${retry+1}/3`);
          this._sendBatchChunk(chunk, idx, retry + 1);
        } else if (retry >= 3) {
          logger.error(`[HeliusWS] ❌ 块[${idx}] 重试3次仍失败，包含 ${chunk.length} 个 token`);
        }
      }
    }, 10000);
  }

  _fallbackToIndividual() {
    // ★ FIX: 独立订阅作为兜底方案，间隔改为 300ms(避免触发 Helius 限流)
    //   并检查是否已经有 subId，跳过已订阅的
    let i = 0;
    for (const [addr, info] of this._tokens.entries()) {
      if (info.subId) continue; // 已订阅跳过
      setTimeout(() => {
        if (this._tokens.has(addr) && this._connected) {
          const cur = this._tokens.get(addr);
          if (cur && !cur.subId) this._subscribeToken(addr);
        }
      }, i * 300);
      i++;
    }
    logger.info(`[HeliusWS] 🔄 降级独立订阅 ${i} 个 token (间隔300ms)`);
  }

  subscribe(tokenAddress, symbol, onTrade) {
    this._tokens.set(tokenAddress, { symbol, onTrade, subId: null });
    const count = this._tokens.size;

    if (this._connected) {
      // ★ FIX: 不再区分"是否达到 BATCH_THRESHOLD",统一走批量订阅
      //   原因：Helius 单 WS 连接对 transactionSubscribe 订阅槽位有隐式限制(~50个)
      //         独立订阅每个币占一个槽位，49个币就可能打满。
      //         批量订阅用一次 transactionSubscribe 把多个 accountInclude 合并，
      //         只占用 1~几个槽位，可以稳定监控数百个币。
      //
      // ★ FIX: 防抖改为"排队合并"而非"重置计时器"，避免币陆续加入导致永远不触发
      this._pendingSubAdditions = this._pendingSubAdditions || new Set();
      this._pendingSubAdditions.add(tokenAddress);

      if (!this._batchDebounce) {
        this._batchDebounce = setTimeout(() => {
          this._batchDebounce = null;
          const addedCount = (this._pendingSubAdditions && this._pendingSubAdditions.size) || 0;
          this._pendingSubAdditions = null;
          if (this._connected) {
            logger.info(`[HeliusWS] 📦 批量订阅触发 (新增 ${addedCount} 个，总 ${this._tokens.size})`);
            this._subscribeBatch();
          }
        }, 5000);  // ★ FIX: 5秒聚合，适合 95+ 币场景陆续加入/退出时减少重订阅风暴
      }
    }
    logger.info(`[HeliusWS] 📌 注册 ${symbol}，当前监控 ${count} 个`);
  }

  unsubscribe(tokenAddress) {
    if (!this._batchSubId) this._unsubscribeToken(tokenAddress);
    this._tokens.delete(tokenAddress);

    // ★ FIX: 使用批量订阅模式时，删除后需要重建订阅（新的 accountInclude 列表）
    //   同样改为"不重置计时器"的排队模式
    if (this._batchSubId && this._connected) {
      if (!this._batchDebounce) {
        this._batchDebounce = setTimeout(() => {
          this._batchDebounce = null;
          if (this._connected) {
            logger.info(`[HeliusWS] 📦 代币移除触发重订阅 (当前 ${this._tokens.size} 个)`);
            this._subscribeBatch();
          }
        }, 5000);  // ★ FIX: 5秒聚合,与 subscribe 一致
      }
    }
    logger.info(`[HeliusWS] 🔕 移除 ${tokenAddress.slice(0,8)}，剩余 ${this._tokens.size} 个`);
  }

  _handleMessage(rawData) {
    let msg;
    try { msg = JSON.parse(rawData.toString('utf8')); } catch (_) { return; }

    if (msg.id && msg.result !== undefined) {
      const key = this._pendingSubs.get(msg.id);
      if (!key) return;
      this._pendingSubs.delete(msg.id);

      if (key.startsWith('__batch_')) {
        // ★ FIX: 清理 pendingBatchChunks 跟踪(收到确认,取消重试计时)
        if (this._pendingBatchChunks) this._pendingBatchChunks.delete(msg.id);

        if (typeof msg.result === 'number') {
          this._batchSubIds.push(msg.result);
          if (!this._batchSubId) this._batchSubId = msg.result;
          clearTimeout(this._batchTimeoutTimer); // 收到确认，取消降级计时
          logger.info(`[HeliusWS] ✅ 批量订阅块确认 subId=${msg.result} (共 ${this._batchSubIds.length} 块)`);
        } else {
          logger.warn(`[HeliusWS] ❌ 批量订阅块失败 rpcId=${msg.id}: ${JSON.stringify(msg).slice(0,200)}`);
          // ★ FIX: 批量订阅失败不再直接降级到独立订阅(独立订阅也会撞订阅槽位限制)
          //   改为：等待其他块确认，或靠 _sendBatchChunk 的超时重试处理
        }
      } else {
        const info = this._tokens.get(key);
        if (info) {
          info.subId = msg.result;
          logger.debug(`[HeliusWS] ✅ 独立订阅确认 ${key.slice(0,8)} subId=${msg.result}`);
        }
      }
      return;
    }

    if (msg.method === 'transactionNotification' && msg.params && msg.params.result) {
      this._stats.txReceived++;
      this._parseTransaction(msg.params.result);
    }
  }

  _parseTransaction(result) {
    try {
      const txWrapper = result.transaction;
      if (!txWrapper) return;
      const meta   = txWrapper.meta;
      const txData = txWrapper.transaction;
      if (!meta || meta.err) return;

      const postTokenBals = meta.postTokenBalances || [];
      if (postTokenBals.length === 0) return;

      const involvedMints = new Set(postTokenBals.map(b => b.mint).filter(Boolean));
      let matched = false;

      for (const mint of involvedMints) {
        const tokenInfo = this._tokens.get(mint);
        if (!tokenInfo) continue;
        matched = true;
        this._stats.txMatched++;
        const trade = this._extractTrade(mint, meta, txData, result.signature);
        if (trade) {
          this._stats.txParsed++;
          tokenInfo.onTrade(trade);
        }
      }

      if (!matched) this._stats.txSkipped++;
    } catch (err) {
      logger.debug(`[HeliusWS] 解析交易失败: ${err.message}`);
    }
  }

  _extractTrade(tokenAddress, meta, txData, signature) {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const preTokenBals  = meta.preTokenBalances  || [];
    const postTokenBals = meta.postTokenBalances  || [];
    const preBalances   = meta.preBalances  || [];
    const postBalances  = meta.postBalances || [];

    // ── 获取交易签名者(fee payer = 用户钱包) ────────────────────
    // Solana 交易的 message.accountKeys[0] 就是签名者 (feePayer)
    let signer = null;
    try {
      const msg = txData && txData.message;
      if (msg) {
        // 两种可能格式：accountKeys 数组（字符串）或对象数组（jsonParsed）
        const keys = msg.accountKeys || [];
        const first = keys[0];
        if (typeof first === 'string') signer = first;
        else if (first && first.pubkey) signer = first.pubkey;
      }
    } catch (_) {}

    // ── 1. 找到目标 token 的所有账户变化 ─────────────────────────
    const postEntries = postTokenBals.filter(b => b.mint === tokenAddress);
    const preEntries  = preTokenBals.filter(b => b.mint === tokenAddress);
    if (postEntries.length === 0) return null;

    // 计算每个账户的 delta
    const tokenDeltas = [];
    for (const postEntry of postEntries) {
      const preEntry = preEntries.find(b =>
        b.accountIndex === postEntry.accountIndex || b.owner === postEntry.owner);
      const postAmt = parseFloat((postEntry.uiTokenAmount && postEntry.uiTokenAmount.uiAmount) || '0');
      const preAmt  = preEntry ? parseFloat((preEntry.uiTokenAmount && preEntry.uiTokenAmount.uiAmount) || '0') : 0;
      const delta = postAmt - preAmt;
      if (Math.abs(delta) > 1e-9) {
        tokenDeltas.push({
          delta,
          owner: postEntry.owner,
          accountIndex: postEntry.accountIndex,
          isSigner: postEntry.owner === signer,  // ★ 是否是签名者账户
        });
      }
    }
    // ★ 处理 pre 有 post 无的情况（账户被关闭）
    for (const preEntry of preEntries) {
      const found = postEntries.find(b =>
        b.accountIndex === preEntry.accountIndex || b.owner === preEntry.owner);
      if (!found) {
        const preAmt = parseFloat((preEntry.uiTokenAmount && preEntry.uiTokenAmount.uiAmount) || '0');
        if (preAmt > 1e-9) {
          tokenDeltas.push({
            delta: -preAmt,
            owner: preEntry.owner,
            accountIndex: preEntry.accountIndex,
            isSigner: preEntry.owner === signer,
          });
        }
      }
    }
    if (tokenDeltas.length === 0) return null;

    // ── 2. 方向判断：优先用签名者账户的 delta ────────────────────
    //   AMM swap 里，签名者账户的 token delta 正负 = 买/卖方向
    //   买入: 用户 token +X, pool token -X → 签名者 delta > 0
    //   卖出: 用户 token -X, pool token +X → 签名者 delta < 0
    let userDelta = null;
    const signerDeltas = tokenDeltas.filter(d => d.isSigner);
    if (signerDeltas.length > 0) {
      // 签名者账户可能有多个（ATA + 直接账户），取净变化
      userDelta = signerDeltas.reduce((s, d) => s + d.delta, 0);
    }
    // 兜底：如果拿不到签名者（txData 结构异常），用 min(|sumPos|, |sumNeg|) 的方向
    //   此时方向可能错，但至少成交量正确
    if (userDelta === null || Math.abs(userDelta) < 1e-9) {
      // 最坏情况：没法可靠判断方向，看正负变化总和的平衡
      let sumPositive = 0, sumNegative = 0;
      for (const d of tokenDeltas) {
        if (d.delta > 0) sumPositive += d.delta;
        else sumNegative += d.delta;
      }
      // 规则：net = sumPos + sumNeg
      //   net 明显 > 0 → 用户净收到 token（买入）
      //   net 明显 < 0 → 用户净付出 token（卖出）
      //   |net| 接近 0 → swap 平衡，无法判断，跳过这笔
      const net = sumPositive + sumNegative;
      const total = sumPositive - sumNegative; // |sumPos|+|sumNeg|
      if (Math.abs(net) / total < 0.01) {
        // 纯 swap 找不到净方向，跳过
        return null;
      }
      userDelta = net;
    }

    const isBuy = userDelta > 0;
    const absTokenDelta = Math.abs(userDelta);

    // ── 3. SOL 金额：优先用签名者的 SOL/WSOL 变化 ────────────────
    //   签名者账户的 native SOL 或 WSOL ATA 的变化 = 用户付/收的 SOL

    // 先找签名者账户的 index（用于 preBalances/postBalances 查找 native SOL）
    let signerIdx = -1;
    try {
      const keys = (txData && txData.message && txData.message.accountKeys) || [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const pk = typeof k === 'string' ? k : (k && k.pubkey);
        if (pk === signer) { signerIdx = i; break; }
      }
    } catch (_) {}

    // 签名者 native SOL 变化（扣除手续费影响）
    let signerNativeDelta = 0;
    if (signerIdx >= 0 && signerIdx < preBalances.length && signerIdx < postBalances.length) {
      signerNativeDelta = Math.abs(postBalances[signerIdx] - preBalances[signerIdx]) / LAMPORTS;
      // 扣掉 priority fee 和 base fee 的影响（通常 < 0.01 SOL）
      // meta.fee 是实际手续费(lamports)
      const feeSol = (meta.fee || 5000) / LAMPORTS;
      signerNativeDelta = Math.max(0, signerNativeDelta - feeSol);
    }

    // 签名者的 WSOL ATA 变化
    let signerWsolDelta = 0;
    const signerWsolPost = postTokenBals.filter(b => b.mint === WSOL && b.owner === signer);
    const signerWsolPre  = preTokenBals.filter(b => b.mint === WSOL && b.owner === signer);
    for (const wp of signerWsolPost) {
      const wr = signerWsolPre.find(b => b.accountIndex === wp.accountIndex);
      const postAmt = parseFloat((wp.uiTokenAmount && wp.uiTokenAmount.uiAmount) || '0');
      const preAmt  = wr ? parseFloat((wr.uiTokenAmount && wr.uiTokenAmount.uiAmount) || '0') : 0;
      signerWsolDelta += Math.abs(postAmt - preAmt);
    }
    // WSOL 账户可能被关闭（wrap/unwrap）
    for (const wr of signerWsolPre) {
      const found = signerWsolPost.find(b => b.accountIndex === wr.accountIndex);
      if (!found) {
        const preAmt = parseFloat((wr.uiTokenAmount && wr.uiTokenAmount.uiAmount) || '0');
        if (preAmt > 1e-9) signerWsolDelta += preAmt;
      }
    }

    // 合计签名者的 SOL 流动（WSOL + native,两者互补,加起来才是总 SOL 流动）
    //   - Pump AMM: 用户直接付 native SOL → signerNativeDelta
    //   - Raydium:  用户先 wrap SOL → WSOL → swap → signerWsolDelta
    //   - 有些钱包:先从 WSOL ATA 拿 WSOL，不足时 wrap → 两者都有
    let solAmount = signerNativeDelta + signerWsolDelta;

    // ── 4. 如果签名者路径失败(solAmount ≈ 0),用 pool 侧的 SOL 流动做兜底 ──
    //   pool 侧的 SOL 流动和用户侧相反但数值相等（忽略 fee）
    const MIN_SOL_DELTA = 0.0001;
    if (solAmount < MIN_SOL_DELTA) {
      // 找 pool 账户的 WSOL 变化（排除 signer）
      let poolWsolSum = 0;
      for (const wp of postTokenBals.filter(b => b.mint === WSOL && b.owner !== signer)) {
        const wr = preTokenBals.find(b => b.mint === WSOL && (b.accountIndex === wp.accountIndex || b.owner === wp.owner));
        const postAmt = parseFloat((wp.uiTokenAmount && wp.uiTokenAmount.uiAmount) || '0');
        const preAmt  = wr ? parseFloat((wr.uiTokenAmount && wr.uiTokenAmount.uiAmount) || '0') : 0;
        poolWsolSum += Math.abs(postAmt - preAmt);
      }
      // pool 侧可能有多个变化（多跳路由），取最大的单账户变化作为真实成交
      // 但简化起见先用 sum 的一半（近似一来一回）
      if (poolWsolSum > MIN_SOL_DELTA) solAmount = poolWsolSum / 2;
    }

    if (solAmount < MIN_SOL_DELTA) return null;

    // ── 5. 过滤异常交易 ─────────────────────────────────────────
    //   多跳路由里本 token 只是中间品，signer 实际付的是另一个 token 而非 SOL
    //   此时 solAmount 虽然有值，但不该计入这个 token 的交易量
    //   判断：如果签名者的 WSOL/native 变化为 0，且交易涉及 2+ 非 WSOL token，跳过
    const nonWsolMintsInvolved = new Set(
      postTokenBals
        .filter(b => b.mint && b.mint !== WSOL && b.owner === signer)
        .map(b => b.mint)
    );
    if (signerNativeDelta < MIN_SOL_DELTA && signerWsolDelta < MIN_SOL_DELTA && nonWsolMintsInvolved.size > 1) {
      // 签名者在做 token A → token B 的直接兑换，本 token 可能只是中间步骤
      return null;
    }

    return {
      ts: Date.now(), signature, tokenAddress,
      owner: signer || '',
      isBuy,
      solAmount,
      tokenAmount: absTokenDelta,
      priceSol: absTokenDelta > 0 ? solAmount / absTokenDelta : 0,
    };
  }

  isConnected() { return this._connected; }
  getSubscriptionCount() { return this._tokens.size; }

  getStats() {
    let confirmedSubs = 0;
    for (const info of this._tokens.values()) { if (info.subId) confirmedSubs++; }
    // ★ FIX: 精确的已订阅币数量
    //   - 批量模式: 所有 batchSubIds 对应的块都覆盖到就是 tokens.size
    //   - 独立模式: subId 非 null 的数量
    const inBatchMode = this._batchSubIds.length > 0;
    const pendingBatchChunks = (this._pendingBatchChunks && this._pendingBatchChunks.size) || 0;
    return {
      connected:     this._connected,
      connType:      this._connType,
      subMode:       inBatchMode ? 'batch' : (confirmedSubs > 0 ? 'token' : 'none'),
      tokens:        this._tokens.size,
      confirmedSubs: inBatchMode ? this._tokens.size : confirmedSubs,
      batchSubId:    this._batchSubId || null,
      batchSubIds:   this._batchSubIds.length,
      batchActive:   inBatchMode,
      pendingBatchChunks,   // 还在等确认的批量块数
      retryCount:    this._retryCount,
      ...this._stats,
    };
  }
}

const heliusWs = new HeliusTradeStream();
module.exports = heliusWs;
