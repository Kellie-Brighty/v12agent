import OpenAI from 'openai';
import { updateConfig } from './config_manager';
import type { TradeContext } from './memory';
import type { Candle } from './bot';

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

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
    "MIN_SWEEP_DISTANCE": "number (optional new override)",
    "MIN_FVG_PIPS": "number (optional new override)",
    "RISK_PERCENT": "number (optional new override)",
    "MIN_RR": "number (optional new override)",
    "FVG_PROXIMITY": "number (optional new override)"
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
${JSON.stringify(candles.map(c => ({ t: new Date(c.time).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }))) }
`;

    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: getSystemPrompt(eventType, outcome) },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    });

    const resultText = response.choices[0]?.message?.content || '{}';
    const analysisJson = JSON.parse(resultText);
    
    console.log(`🤖 [BRAIN] Diagnosis: ${analysisJson.analysis || 'None'}`);
    console.log(`🤖 [BRAIN] Action: ${analysisJson.recommended_action}`);
    
    if (analysisJson.updated_parameters && Object.keys(analysisJson.updated_parameters).length > 0) {
      updateConfig(analysisJson.updated_parameters);
    }
    
  } catch (error) {
    console.error('🤖 [BRAIN ERROR] Micro-Reflection failed:', error);
  }
}
