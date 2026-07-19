import OpenAI from 'openai';
import { updateConfig } from './config_manager';
import { logBrainNarrative, getRecentBrainLogs } from './memory';
import type { TradeContext } from './memory';
import type { Candle, SwingPoint } from './bot';

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

// ── Resilient DeepSeek caller with retry + exponential backoff ─────────────
async function callDeepSeek(
  messages: { role: 'system' | 'user'; content: string }[],
  temperature = 0.1,
  maxRetries = 3,
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: 'deepseek-v4-flash',
        messages,
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: 1000,
      });
      const text = response.choices[0]?.message?.content;
      if (!text || text.trim() === '') {
        throw new Error('DeepSeek returned an empty response.');
      }
      return text;
    } catch (err: unknown) {
      const isLast = attempt === maxRetries;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isLast) {
        console.warn(`🧠 [BRAIN] All ${maxRetries} attempts failed: ${errMsg}`);
        throw err;
      }
      const delay = 1000 * attempt; // 1s, 2s, 3s
      console.warn(`🧠 [BRAIN] Attempt ${attempt} failed ("${errMsg}"). Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('callDeepSeek: unreachable');
}

function getSystemPrompt(eventType: string, outcome: string) {
  let mode = '';
  if (eventType === 'trade_closed' && outcome === 'loss') {
    mode = 'You are analyzing a paper trade that resulted in a LOSS. Diagnose why it failed (e.g., trap, chop) and tighten parameters.';
  } else if (eventType === 'trade_closed' && outcome === 'win') {
    mode = 'You are analyzing a paper trade that resulted in a WIN. Identify why the setup was high-probability and reinforce or slightly optimize the parameters.';
  } else if (eventType === 'observation') {
    mode = 'You are analyzing an OBSERVATION. A market event (like a liquidity sweep) occurred, but the bot decided to skip the trade. Determine if skipping was correct, or if parameters (like FVG requirements or RR) were too strict and missed a good move.';
  }

  return `
You are the ICT algorithmic trading "Brain". You are extremely disciplined, highly analytical, and completely devoid of emotion. 
You strictly adhere to ICT (Inner Circle Trader) concepts: Liquidity Sweeps, Market Structure Shifts (MSS), Fair Value Gaps (FVG), and optimal trade entries during Kill Zones.

${mode}

Output MUST be valid JSON matching this schema:
{
  "analysis": "string (e.g. 'False sweep / Inducement trap' or 'Perfect clean FVG')",
  "recommended_action": "string (e.g. 'Increase sweep depth requirement' or 'Maintain parameters')",
  "updated_parameters": {
    "MIN_SWEEP_DISTANCE": "number (optional new override, decimal percentage e.g. 0.0005 for 0.05%)",
    "MIN_FVG_PIPS": "number (optional new override, decimal percentage e.g. 0.0008 for 0.08%)",
    "RISK_PERCENT": "number (optional new override, decimal percentage e.g. 0.01 for 1%)",
    "MIN_RR": "number (optional new override, decimal ratio e.g. 1.5 or 2.0)",
    "FVG_PROXIMITY": "number (optional new override, multiplier e.g. 3.0)",
    "TRADE_DEAD_ZONES": "boolean (optional new override, set to true to execute trades outside kill zones)"
  }
}
`;
}

export async function triggerMicroReflection(eventType: string, context: TradeContext, outcome: string, candles: Candle[]) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('⚠️ DEEPSEEK_API_KEY is not set. Micro-Reflection aborted.');
    return;
  }

  console.log(`🤖 [BRAIN] Analyzing event: ${eventType} (${outcome}) on ${context.symbol}...`);
  
  try {
    // ── Fetch recent brain memory for RAG injection ────────────────────────
    const recentMemory = await getRecentBrainLogs(context.symbol, 4, 3);
    if (recentMemory.length > 0) {
      console.log(`🤖 [BRAIN] 📥 Loaded ${recentMemory.length} past memory entries for context.`);
    } else {
      console.log(`🤖 [BRAIN] 📥 No past memory yet — starting fresh.`);
    }
    const memoryBlock = recentMemory.length > 0
      ? `YOUR RECENT MEMORY (last ${recentMemory.length} brain logs for ${context.symbol}):
${JSON.stringify(recentMemory, null, 2)}

Use your memory to inform this analysis. Note if you have seen similar setups before, and whether your past parameter adjustments have improved outcomes.`
      : '(No recent memory available for this symbol yet.)';

    const prompt = `
TRADE CONTEXT:
- Symbol: ${context.symbol}
- Kill Zone: ${context.killZone}
- HTF Bias: ${context.htfBias}
- Setup: ${context.setupType}
- Outcome: ${outcome}
- Entry Price: ${context.entryPrice}
- Stop Loss: ${context.stopLoss}
- Take Profit: ${context.takeProfit}

RECENT 1M CANDLE DATA (JSON):
${JSON.stringify(candles.slice(-10).map(c => ({ t: new Date(c.time).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }))) }

${memoryBlock}
`;

    const resultText = await callDeepSeek([
        { role: 'system', content: getSystemPrompt(eventType, outcome) },
        { role: 'user',   content: prompt },
      ], 0.1);
    const analysisJson = JSON.parse(resultText);
    
    console.log(`🤖 [BRAIN] Diagnosis: ${analysisJson.analysis || 'None'}`);
    console.log(`🤖 [BRAIN] Action: ${analysisJson.recommended_action}`);
    
    if (analysisJson.updated_parameters && Object.keys(analysisJson.updated_parameters).length > 0) {
      updateConfig(analysisJson.updated_parameters);
    }

    // Persist reflection to Firebase
    logBrainNarrative(context.symbol, 'micro_reflection', {
      eventType,
      outcome,
      killZone:  context.killZone,
      htfBias:   context.htfBias,
      diagnosis: analysisJson.analysis,
      recommended_action: analysisJson.recommended_action,
      updated_parameters: analysisJson.updated_parameters ?? {},
    }).catch(() => {});
    
  } catch (error) {
    console.error('🤖 [BRAIN ERROR] Micro-Reflection failed:', error);
  }
}

// ── Live Tape Reading ──────────────────────────────────────────────────────
// Triggered every time a new 1-min swing point is confirmed, or every 5 min.
// DeepSeek reads both 15m HTF (macro context) and recent 1m LTF (current tape)
// and narrates what is happening right now in the context of the bigger picture.


export async function analyzeLTFStructure(
  symbol:       string,
  ltfSwings:    SwingPoint[],
  htfSwings:    SwingPoint[],
  htfBias:      string,
  killZone:     string,
  recentCandles: Candle[],
): Promise<number | null> {  // returns the key level to watch so bot.ts can track breakouts
  if (!process.env.DEEPSEEK_API_KEY) return null;

  const currentCandle = recentCandles[recentCandles.length - 1]!;
  const currentPrice  = currentCandle.close;
  const currentTime   = new Date(currentCandle.time * 1000).toUTCString();

  // ── MACRO context: last 5 HTF (15m) swing points — full session history ──
  const htfSwingData = htfSwings.slice(-5).map(s => ({
    time:  new Date(s.time * 1000).toUTCString(),
    type:  s.type,
    price: s.price.toFixed(2),
  }));

  // ── MICRO context: 1m swings from last 30 minutes ONLY ──
  const thirtyMinAgo    = currentCandle.time - 30 * 60;
  const recentLtfSwings = ltfSwings
    .filter(s => s.time >= thirtyMinAgo)
    .map(s => ({
      time:  new Date(s.time * 1000).toUTCString(),
      type:  s.type,
      price: s.price.toFixed(2),
    }));

  // ── CURRENT TAPE: last 10 1m candles (most recent price action) ──
  const recentBars = recentCandles.slice(-10).map(c => ({
    t: new Date(c.time * 1000).toUTCString(),
    o: c.open.toFixed(2),
    h: c.high.toFixed(2),
    l: c.low.toFixed(2),
    c: c.close.toFixed(2),
  }));

  const systemPrompt = `
You are the ICT algorithmic trading "Brain" performing LIVE TAPE READING.
You are given a two-layer market view:
  1. MACRO (15-minute HTF swings) — for understanding institutional context and major liquidity pools.
  2. MICRO (1-minute LTF swings from the last 30 minutes) — for understanding what price is doing RIGHT NOW.
  3. CURRENT STATE — an explicit anchor to the current price and last bar so you are never commenting on stale data.

Your job:
- Reference the CURRENT PRICE explicitly in your analysis.
- Use the 15m HTF swings to understand the macro story (where are the big draws on liquidity?).
- Use the 1m LTF swings to explain what is happening at the execution level right now.
- Identify if 1m price action is WITH or AGAINST the 15m bias.
- Flag if a Sweep → Market Structure Shift → FVG entry is forming or imminent.
- Call out specific price levels that matter RIGHT NOW (not from hours ago).

Keep narrative concise (4–6 sentences). Always reference the current price. Use ICT terminology.
Output MUST be valid JSON:
{
  "narrative": "string — your live tape reading commentary referencing current price",
  "alert_level": "high | medium | low",
  "key_level_to_watch": "number or null (the single most important price level right now)"
}
`;

  const userPrompt = `
━━━ CURRENT STATE (anchor) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYMBOL:        ${symbol}
CURRENT PRICE: $${currentPrice.toFixed(2)}
CURRENT TIME:  ${currentTime}
KILL ZONE:     ${killZone}
LAST BAR:      O:${currentCandle.open.toFixed(2)}  H:${currentCandle.high.toFixed(2)}  L:${currentCandle.low.toFixed(2)}  C:${currentCandle.close.toFixed(2)}

━━━ MACRO CONTEXT (15m HTF swings — institutional structure) ━
15M BIAS: ${htfBias.toUpperCase()}
${JSON.stringify(htfSwingData, null, 2)}

━━━ MICRO CONTEXT (1m LTF swings — last 30 min only) ━━━━━━━━━
${recentLtfSwings.length > 0 ? JSON.stringify(recentLtfSwings, null, 2) : '(No new 1m swing points in the last 30 minutes — price is trending without confirmed structure)'}

━━━ RECENT 1m CANDLES (last 10 bars) ━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(recentBars, null, 2)}
`;

  try {
    console.log(`\n🧠 [BRAIN - TAPE READ] Analyzing 1m structure for ${symbol} @ $${currentPrice.toFixed(2)}...`);

    // ── Fetch recent brain memory for RAG injection ────────────────────────
    const recentMemory = await getRecentBrainLogs(symbol, 5, 2);
    if (recentMemory.length > 0) {
      console.log(`🧠 [BRAIN] 📥 Loaded ${recentMemory.length} past memory entries for context.`);
    } else {
      console.log(`🧠 [BRAIN] 📥 No past memory yet — this is a fresh analysis.`);
    }
    const memorySection = recentMemory.length > 0
      ? `
━━━ YOUR RECENT MEMORY (last ${recentMemory.length} thoughts about ${symbol}) ━━━━━━━━━
${JSON.stringify(recentMemory, null, 2)}

Critically evaluate your past calls: Were your previous alert levels correct? Did the key levels you flagged get swept or respected? Adjust your current analysis based on what you now know happened.`
      : '';

    const resultText = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt + memorySection },
    ], 0.2);

    const result = JSON.parse(resultText);

    console.log(`🧠 [BRAIN] 📖 ${result.narrative}`);
    console.log(`🧠 [BRAIN] 🚦 Alert Level: ${(result.alert_level ?? 'unknown').toUpperCase()}`);
    const keyLevel: number | null = result.key_level_to_watch ?? null;
    if (keyLevel) {
      console.log(`🧠 [BRAIN] 🎯 Key Level: $${keyLevel} (watching for breakout...)`);
    }
    console.log('');

    // Persist tape read to Firebase
    logBrainNarrative(symbol, 'tape_read', {
      killZone,
      htfBias,
      narrative:          result.narrative,
      alert_level:        result.alert_level,
      key_level_to_watch: keyLevel,
    }).catch(() => {});

    return keyLevel; // return so bot.ts can track this level
  } catch (err) {
    console.error('🧠 [BRAIN ERROR] Tape Read failed:', err);
    return null;
  }
}
