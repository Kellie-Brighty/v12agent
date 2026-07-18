/**
 * bot.ts — V12Agent ICT Trading Bot
 *
 * Strategy: Liquidity Sweep + Fair Value Gap (FVG) Entry
 * Based on Michael Huddleston's (ICT) concepts
 *
 * Entry Model:
 *  1. Identify market bias via structure (HH+HL = bullish, LH+LL = bearish)
 *  2. Wait for a liquidity sweep (price wicks through prior swing, closes back)
 *  3. Confirm a Fair Value Gap or Order Block forms after the sweep
 *  4. Enter when price retraces into the FVG / OB
 *  5. Stop: below the sweep low (or above for shorts)
 *  6. Target: next swing high / previous liquidity pool
 *
 * Time filter: Kill Zones only (London Open, NY Open, London Close)
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

import { getConfig, type BotConfig } from './config_manager';
import { logTradeEvent, logObservationEvent, type TradeContext } from './memory';

export const BOT_CONFIG = new Proxy({} as BotConfig, {
  get: (_, prop: string | symbol) => {
    if (typeof prop === 'string') {
      return getConfig()[prop as keyof BotConfig];
    }
    return undefined;
  }
});

// Kill zones (UTC hours — crypto trades 24/7 so these still apply)
const KILL_ZONES = [
  { name: 'London Open',  startH: 7,  endH: 10 }, // 02:00–05:00 EST
  { name: 'NY Open',      startH: 12, endH: 15 }, // 07:00–10:00 EST
  { name: 'London Close', startH: 15, endH: 17 }, // 10:00–12:00 EST
] as const;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Candle {
  time:   number; // unix seconds
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface SwingPoint {
  index: number;
  time:  number;
  price: number;
  type:  'high' | 'low';
}

export interface FVG {
  time:        number;
  top:         number;
  bottom:      number;
  type:        'bullish' | 'bearish';
  candleIndex: number;
}

export interface OrderBlock {
  time:  number;
  open:  number;
  close: number;
  high:  number;
  low:   number;
  type:  'bullish' | 'bearish';
}

export interface LiquiditySweep {
  time:        number;
  type:        'sweep_low' | 'sweep_high';
  sweptPrice:  number;
  closePrice:  number;
  candleIndex: number;
}

export interface TradeSetup {
  symbol:     string;
  bias:       MarketBias;
  killZone:   string;
  sweep:      LiquiditySweep;
  fvg:        FVG;
  entry:      number;
  stopLoss:   number;
  takeProfit: number;
  rr:         number;
  qty:        number;
  side:       'buy' | 'sell';
}

export type MarketBias = 'bullish' | 'bearish' | 'ranging';

interface Position {
  symbol:     string;
  side:       'long' | 'short';
  entry:      number;
  stopLoss:   number;
  takeProfit: number;
  qty:        number;
  entryTime:  number;
}

// ─── In-Memory State ───────────────────────────────────────────────────────

const openPositions = new Map<string, Position>();

// ─── Kill Zone ─────────────────────────────────────────────────────────────

export function getKillZone(unixSeconds: number): { active: boolean; name?: string } {
  const d    = new Date(unixSeconds * 1000);
  const hour = d.getUTCHours();
  const min  = d.getUTCMinutes();
  const t    = hour + min / 60;

  for (const kz of KILL_ZONES) {
    if (t >= kz.startH && t < kz.endH) return { active: true, name: kz.name };
  }
  return { active: false };
}

// ─── Swing Detection ───────────────────────────────────────────────────────

export function detectSwings(
  candles: Candle[],
  lookback = BOT_CONFIG.SWING_LOOKBACK,
): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const curr = candles[i]!;

    // Swing High: higher than all candles within lookback on both sides
    const isSwingHigh = Array.from({ length: lookback }).every((_, k) =>
      candles[i - k - 1]!.high <= curr.high && candles[i + k + 1]!.high <= curr.high,
    );
    if (isSwingHigh) {
      swings.push({ index: i, time: curr.time, price: curr.high, type: 'high' });
    }

    // Swing Low: lower than all candles within lookback on both sides
    const isSwingLow = Array.from({ length: lookback }).every((_, k) =>
      candles[i - k - 1]!.low >= curr.low && candles[i + k + 1]!.low >= curr.low,
    );
    if (isSwingLow) {
      swings.push({ index: i, time: curr.time, price: curr.low, type: 'low' });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

// ─── Market Structure / Bias ───────────────────────────────────────────────

export function getMarketBias(swings: SwingPoint[]): MarketBias {
  const highs = swings.filter(s => s.type === 'high').slice(-3);
  const lows  = swings.filter(s => s.type === 'low').slice(-3);

  if (highs.length < 2 || lows.length < 2) return 'ranging';

  const lastHigh = highs[highs.length - 1]!.price;
  const prevHigh = highs[highs.length - 2]!.price;
  const lastLow  = lows[lows.length - 1]!.price;
  const prevLow  = lows[lows.length - 2]!.price;

  const hh = lastHigh > prevHigh; // Higher High
  const hl  = lastLow  > prevLow;  // Higher Low
  const lh  = lastHigh < prevHigh; // Lower High
  const ll  = lastLow  < prevLow;  // Lower Low

  if (hh && hl) return 'bullish';
  if (lh && ll) return 'bearish';
  return 'ranging';
}

// ─── Fair Value Gap (FVG) Detection ───────────────────────────────────────

export function detectFVGs(candles: Candle[]): FVG[] {
  const fvgs: FVG[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2]!; // First candle
    const c3 = candles[i]!;     // Third candle (c2 is the impulse candle)

    // Bullish FVG: gap between c1 high and c3 low (price never traded there)
    if (c3.low > c1.high) {
      const size = (c3.low - c1.high) / c1.high;
      if (size >= BOT_CONFIG.MIN_FVG_PIPS) {
        fvgs.push({
          time:        c3.time,
          top:         c3.low,
          bottom:      c1.high,
          type:        'bullish',
          candleIndex: i,
        });
      }
    }

    // Bearish FVG: gap between c1 low and c3 high
    if (c3.high < c1.low) {
      const size = (c1.low - c3.high) / c1.low;
      if (size >= BOT_CONFIG.MIN_FVG_PIPS) {
        fvgs.push({
          time:        c3.time,
          top:         c1.low,
          bottom:      c3.high,
          type:        'bearish',
          candleIndex: i,
        });
      }
    }
  }

  return fvgs;
}

// ─── Order Block Detection ─────────────────────────────────────────────────

export function detectOrderBlocks(candles: Candle[], swings: SwingPoint[]): OrderBlock[] {
  const obs: OrderBlock[] = [];

  // Bullish OB: last bearish candle before the impulse into a swing HIGH
  for (const sh of swings.filter(s => s.type === 'high')) {
    for (let i = sh.index - 1; i >= Math.max(0, sh.index - 15); i--) {
      const candle = candles[i]!;
      if (candle.close < candle.open) { // bearish candle
        obs.push({ ...candle, type: 'bullish' });
        break;
      }
    }
  }

  // Bearish OB: last bullish candle before the impulse into a swing LOW
  for (const sl of swings.filter(s => s.type === 'low')) {
    for (let i = sl.index - 1; i >= Math.max(0, sl.index - 15); i--) {
      const candle = candles[i]!;
      if (candle.close > candle.open) { // bullish candle
        obs.push({ ...candle, type: 'bearish' });
        break;
      }
    }
  }

  return obs;
}

// ─── Liquidity Sweep Detection ─────────────────────────────────────────────

export function detectLiquiditySweep(
  candles: Candle[],
  swings: SwingPoint[],
): LiquiditySweep | null {
  if (candles.length < 3) return null;

  const last = candles[candles.length - 1]!;
  const recentSwingLows  = swings.filter(s => s.type === 'low').slice(-6);
  const recentSwingHighs = swings.filter(s => s.type === 'high').slice(-6);

  // Bullish sweep: wick BELOW a prior swing low, CLOSES ABOVE it
  // Wick must penetrate at least MIN_SWEEP_DISTANCE beyond the level
  for (const sl of recentSwingLows) {
    const threshold = sl.price * (1 - BOT_CONFIG.MIN_SWEEP_DISTANCE);
    if (last.low <= threshold && last.close > sl.price) {
      return {
        time:        last.time,
        type:        'sweep_low',
        sweptPrice:  sl.price,
        closePrice:  last.close,
        candleIndex: candles.length - 1,
      };
    }
  }

  // Bearish sweep: wick ABOVE a prior swing high, CLOSES BELOW it
  // Wick must penetrate at least MIN_SWEEP_DISTANCE beyond the level
  for (const sh of recentSwingHighs) {
    const threshold = sh.price * (1 + BOT_CONFIG.MIN_SWEEP_DISTANCE);
    if (last.high >= threshold && last.close < sh.price) {
      return {
        time:        last.time,
        type:        'sweep_high',
        sweptPrice:  sh.price,
        closePrice:  last.close,
        candleIndex: candles.length - 1,
      };
    }
  }

  return null;
}


// ─── Order Execution ───────────────────────────────────────────────────────

async function placeOrder(setup: TradeSetup): Promise<void> {
  const tag = `${setup.symbol} ${setup.side.toUpperCase()} | entry=$${setup.entry.toFixed(2)} | SL=$${setup.stopLoss.toFixed(2)} | TP=$${setup.takeProfit.toFixed(2)} | qty=${setup.qty}`;

  if (BOT_CONFIG.DRY_RUN) {
    console.log(`\n🔵 [DRY RUN] Would place: ${tag}`);
    return;
  }

  try {
    const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY_ID!,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY!,
        'Content-Type':        'application/json',
      },
      body: JSON.stringify({
        symbol:        setup.symbol,
        qty:           String(setup.qty),
        side:          setup.side,
        type:          'market',
        time_in_force: 'gtc',
        order_class:   'bracket',
        stop_loss:     { stop_price:  String(setup.stopLoss.toFixed(2)) },
        take_profit:   { limit_price: String(setup.takeProfit.toFixed(2)) },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ Order failed for ${setup.symbol}:`, err);
      return;
    }

    console.log(`✅ Order placed: ${tag}`);
  } catch (err) {
    console.error(`❌ Order error for ${setup.symbol}:`, err);
  }
}

// ─── Account Balance ───────────────────────────────────────────────────────

async function getAccountBalance(): Promise<number> {
  try {
    const res = await fetch('https://paper-api.alpaca.markets/v2/account', {
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY_ID!,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY!,
      },
    });
    const data = await res.json() as { equity?: string; cash?: string };
    return parseFloat(data.equity ?? data.cash ?? '100000');
  } catch {
    return 100000; // Fallback
  }
}

function calcQty(balance: number, riskPct: number, entry: number, stop: number): number {
  const riskAmount  = balance * riskPct;
  const riskPerUnit = Math.abs(entry - stop);
  if (riskPerUnit === 0) return 0;
  return parseFloat((riskAmount / riskPerUnit).toFixed(6));
}

// ─── onBar — Entry Point (called from server.ts after each completed bar) ──
//   candles    = 1-min bars  → sweep, FVG, entry detection
//   htfCandles = 15-min bars → market bias only (more reliable structure)

export async function onBar(
  symbol:     string,
  candles:    Candle[],
  htfCandles: Candle[] = [],  // falls back to 1-min bias if HTF unavailable
): Promise<void> {
  if (candles.length < 20) return;

  const last    = candles[candles.length - 1]!;
  const timeStr = new Date(last.time * 1000).toUTCString();
  const prefix  = `[${symbol}]`;

  // Heartbeat — always visible so we know the bot is alive
  console.log(`${prefix} 🕯  Bar closed @ $${last.close.toFixed(2)} | ${timeStr}`);

  const kz = getKillZone(last.time);

  // ── 2. Already in a position? Check TP/SL ──────────────────────────────
  const openPos = openPositions.get(symbol);
  if (openPos) {
    let closed = false;
    let outcome: 'win' | 'loss' = 'loss';
    
    if (openPos.side === 'long') {
      if (last.low <= openPos.stopLoss) {
        console.log(`${prefix} 🛑 STOP LOSS HIT for LONG`);
        closed = true; outcome = 'loss';
      } else if (last.high >= openPos.takeProfit) {
        console.log(`${prefix} 🎯 TAKE PROFIT HIT for LONG`);
        closed = true; outcome = 'win';
      }
    } else {
      if (last.high >= openPos.stopLoss) {
        console.log(`${prefix} 🛑 STOP LOSS HIT for SHORT`);
        closed = true; outcome = 'loss';
      } else if (last.low <= openPos.takeProfit) {
        console.log(`${prefix} 🎯 TAKE PROFIT HIT for SHORT`);
        closed = true; outcome = 'win';
      }
    }
    
    if (closed) {
      const tContext: TradeContext = {
        symbol,
        entryPrice: openPos.entry,
        stopLoss: openPos.stopLoss,
        takeProfit: openPos.takeProfit,
        setupType: openPos.side === 'long' ? 'bullish_fvg' : 'bearish_fvg',
        htfBias: 'unknown',
        killZone: kz.name || 'unknown'
      };
      logTradeEvent(tContext, outcome, candles);
      clearPosition(symbol);
    } else {
      console.log(`${prefix} 🔒 Position open — skipping\n`);
    }
    return;
  }

  // ── 3. Bias from 15m HTF (fallback to 1-min if not enough HTF data) ──────
  const useHTF      = htfCandles.length >= 10;
  const biasCandles = useHTF ? htfCandles : candles;
  const biasLabel   = useHTF ? '15m' : '1min';
  const htfSwings   = detectSwings(biasCandles, BOT_CONFIG.HTF_SWING_LOOKBACK);
  const bias        = getMarketBias(htfSwings);

  // Keep separate 1-min swings for sweep & FVG detection
  const ltfSwings = detectSwings(candles);

  console.log(`${prefix} 📐 Bias: ${bias.toUpperCase()} [${biasLabel}] | Kill zone: ${kz.name || 'Dead Zone'}`);

  if (bias === 'ranging') {
    console.log(`${prefix} 📊 HTF market ranging — no trade\n`);
    return;
  }

  // ── 4. Liquidity sweep on the most recent 1-min candle ─────────────────
  const sweep = detectLiquiditySweep(candles, ltfSwings);


  if (!sweep) {
    console.log(`${prefix} 👁  No liquidity sweep on this bar — watching\n`);
    return;
  }

  // Sweep must align with bias
  if (bias === 'bullish' && sweep.type !== 'sweep_low') {
    console.log(`${prefix} ↕️  Sweep detected (${sweep.type}) but doesn't align with ${bias} bias — skipping\n`);
    return;
  }
  if (bias === 'bearish' && sweep.type !== 'sweep_high') {
    console.log(`${prefix} ↕️  Sweep detected (${sweep.type}) but doesn't align with ${bias} bias — skipping\n`);
    return;
  }

  console.log(`${prefix} 💧 Liquidity sweep @ $${sweep.sweptPrice.toFixed(2)} — ${sweep.type} ✓`);

  // ── 5. FVG confirmation after the sweep ─────────────────────────────────
  const postSweepCandles = candles.slice(Math.max(0, sweep.candleIndex - 2));
  const fvgs = detectFVGs(postSweepCandles).filter(f =>
    bias === 'bullish' ? f.type === 'bullish' : f.type === 'bearish',
  );

  if (fvgs.length === 0) {
    console.log(`${prefix} ⚡ Sweep confirmed but no ${bias} FVG yet — waiting for confirmation\n`);
    return;
  }

  const fvg      = fvgs[fvgs.length - 1]!;
  const fvgRange = fvg.top - fvg.bottom;
  const fvgMid   = fvg.bottom + fvgRange / 2;

  console.log(`${prefix} 🟦 FVG found: $${fvg.bottom.toFixed(2)} – $${fvg.top.toFixed(2)} (${fvg.type})`);

  // Price must be near or inside the FVG
  const proximityRatio = Math.abs(last!.close - fvgMid) / fvgRange;
  if (proximityRatio <= BOT_CONFIG.FVG_PROXIMITY) {
    // ... (Execute Trade logic below)
  } else {
    console.log(`${prefix} ⚠️ FVG proximity check failed (Ratio: ${proximityRatio.toFixed(2)})`);
    logObservationEvent(`FVG proximity check failed (Ratio: ${proximityRatio.toFixed(2)})`, symbol, candles);
    return;
  }

  // ── 6. Calculate trade parameters ───────────────────────────────────────
  const swingHighs = ltfSwings.filter(s => s.type === 'high');
  const swingLows  = ltfSwings.filter(s => s.type === 'low');
  const entry      = last!.close;

  let side:       'buy' | 'sell';
  let stopLoss:   number;
  let takeProfit: number;

  if (bias === 'bullish') {
    side       = 'buy';
    stopLoss   = sweep.sweptPrice * 0.9995;
    const nextHigh = swingHighs.filter(s => s.price > entry).sort((a, b) => a.price - b.price)[0];
    takeProfit = nextHigh ? nextHigh.price : entry * 1.015;
  } else {
    side       = 'sell';
    stopLoss   = sweep.sweptPrice * 1.0005;
    const nextLow = swingLows.filter(s => s.price < entry).sort((a, b) => b.price - a.price)[0];
    takeProfit = nextLow ? nextLow.price : entry * 0.985;
  }

  // ── 7. Risk / Reward check ──────────────────────────────────────────────
  const rr = Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss);
  if (rr < BOT_CONFIG.MIN_RR) {
    console.log(`${prefix} ⚠️ R:R too low (${rr.toFixed(2)}). Skipping trade.`);
    logObservationEvent(`Setup valid but R:R too low (${rr.toFixed(2)})`, symbol, candles);
    return;
  }

  console.log(`${prefix} ⚖️  R:R = ${rr.toFixed(2)}:1 (min ${BOT_CONFIG.MIN_RR}:1)`);

  // ── 8. Position sizing ──────────────────────────────────────────────────
  const balance = await getAccountBalance();
  const qty     = calcQty(balance, BOT_CONFIG.RISK_PERCENT, entry, stopLoss);

  if (qty <= 0) {
    console.log(`${prefix} ❌ Could not calculate valid qty\n`);
    return;
  }

  // ── 9. Full setup log ───────────────────────────────────────────────────
  const setup: TradeSetup = { symbol, bias, killZone: kz.name!, sweep, fvg, entry, stopLoss, takeProfit, rr, qty, side };

  console.log('\n' + '━'.repeat(60));
  console.log(`🚀 ICT SETUP — ${symbol}`);
  console.log('━'.repeat(60));
  console.log(`  Bias:        ${bias.toUpperCase()}`);
  console.log(`  Kill Zone:   ${kz.name}`);
  console.log(`  Sweep:       $${sweep.sweptPrice.toFixed(2)} (${sweep.type})`);
  console.log(`  FVG:         $${fvg.bottom.toFixed(2)} – $${fvg.top.toFixed(2)} (${fvg.type})`);
  console.log(`  Entry:       $${entry.toFixed(2)}`);
  console.log(`  Stop Loss:   $${stopLoss.toFixed(2)}`);
  console.log(`  Take Profit: $${takeProfit.toFixed(2)}`);
  console.log(`  R:R:         ${rr.toFixed(2)}:1`);
  console.log(`  Qty:         ${qty}`);
  console.log(`  Balance:     $${balance.toFixed(2)}`);
  console.log('━'.repeat(60) + '\n');

  // ── 10. Kill Zone Final Check ───────────────────────────────────────────
  if (!kz.active) {
    console.log(`${prefix} ⏹ Setup is perfectly valid, but we are in a Dead Zone. Logging observation.\n`);
    logObservationEvent('Valid setup formed in Dead Zone. Skipping execution.', symbol, candles);
    return;
  }

  // ── 11. Place order ─────────────────────────────────────────────────────
  await placeOrder(setup);

  // ── 12. Track open position ─────────────────────────────────────────────
  openPositions.set(symbol, {
    symbol,
    side:       side === 'buy' ? 'long' : 'short',
    entry,
    stopLoss,
    takeProfit,
    qty,
    entryTime:  last.time,
  });
}

// ─── Position management ───────────────────────────────────────────────────

export function clearPosition(symbol: string): void {
  openPositions.delete(symbol);
}

export function getOpenPositions(): Map<string, Position> {
  return openPositions;
}


