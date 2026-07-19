import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import path from 'path';
import fs from 'fs';
import type { Candle } from './bot';

// Initialize Firebase Admin
const serviceAccountPath = path.join(process.cwd(), 'firebase-adminsdk.json');
try {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }
  console.log('🔥 Firebase Admin SDK initialized for Memory Layer.');
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK. Please ensure firebase-adminsdk.json exists and is valid.', error);
}

const db = getApps().length > 0 ? getFirestore() : null;

export interface TradeContext {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  setupType: 'bullish_fvg' | 'bearish_fvg' | 'other';
  htfBias: string;
  killZone: string;
}

/**
 * Logs a completed trade event (win or loss) to Firestore.
 */
export async function logTradeEvent(context: TradeContext, outcome: 'win' | 'loss', candles: Candle[]) {
  if (!db) return;
  try {
    const docRef = db.collection('trades').doc();
    await docRef.set({
      timestamp:       FieldValue.serverTimestamp(),
      type:            'trade_closed',
      context,
      outcome,
      candlesSnapshot: JSON.stringify(candles),
    });
    console.log(`🧠 [MEMORY] Logged ${outcome} trade for ${context.symbol} to Firebase.`);

    const { triggerMicroReflection } = await import('./brain.ts');
    triggerMicroReflection('trade_closed', context, outcome, candles).catch(console.error);
  } catch (error) {
    console.error('Failed to log trade event to memory:', error);
  }
}

/**
 * Logs an observation event (skipped setup) to Firestore.
 */
export async function logObservationEvent(
  description: string,
  symbol:      string,
  candles:     Candle[],
  extra?:      { killZone?: string; htfBias?: string },
) {
  if (!db) return;
  try {
    const docRef = db.collection('observations').doc();
    await docRef.set({
      timestamp:       FieldValue.serverTimestamp(),
      type:            'observation',
      description,
      symbol,
      killZone:        extra?.killZone  ?? 'unknown',
      htfBias:         extra?.htfBias   ?? 'unknown',
      candlesSnapshot: JSON.stringify(candles),
    });
    console.log(`🧠 [MEMORY] Logged observation for ${symbol} to Firebase.`);

    const context: TradeContext = {
      symbol, entryPrice: 0, stopLoss: 0, takeProfit: 0,
      setupType: 'other',
      htfBias:   extra?.htfBias  ?? 'unknown',
      killZone:  extra?.killZone ?? 'unknown',
    };
    const { triggerMicroReflection } = await import('./brain.ts');
    triggerMicroReflection('observation', context, 'none', candles).catch(console.error);
  } catch (error) {
    console.error('Failed to log observation event to memory:', error);
  }
}

/**
 * Retrieves the last N brain_log entries for a symbol from the past maxAgeHours.
 * Used by the Brain to inject its own recent thoughts into new DeepSeek prompts (RAG).
 */
export async function getRecentBrainLogs(
  symbol:      string,
  maxEntries = 5,
  maxAgeHours = 2,
): Promise<Record<string, unknown>[]> {
  if (!db) return [];
  try {
    // Fetch latest 30 docs ordered by time, then filter by symbol in-memory.
    // This avoids needing a composite Firestore index.
    const snap = await db.collection('brain_logs')
      .orderBy('timestamp', 'desc')
      .limit(30)
      .get();

    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

    return snap.docs
      .filter(d => {
        const data = d.data();
        const ts   = data.timestamp?.toMillis?.() ?? 0;
        return data.symbol === symbol && ts >= cutoff;
      })
      .slice(0, maxEntries)
      .map(d => {
        const data = d.data();
        // Strip raw candle data and Firestore Timestamp objects — keep it human-readable
        const { candlesSnapshot: _c, timestamp, ...rest } = data;
        return {
          ...rest,
          time: timestamp?.toDate?.().toUTCString() ?? 'unknown',
        };
      });
  } catch (err) {
    console.warn('⚠️ Failed to fetch recent brain logs:', err);
    return [];
  }
}

export async function logBrainNarrative(
  symbol:    string,
  eventType: 'tape_read' | 'micro_reflection',
  payload:   Record<string, unknown>,
) {
  if (!db) return;
  try {
    await db.collection('brain_logs').doc().set({
      timestamp: FieldValue.serverTimestamp(),
      symbol,
      eventType,
      ...payload,
    });
  } catch (error) {
    // Silent fail — don't let logging errors interrupt the bot
    console.warn('⚠️ Failed to save brain narrative to Firebase:', error);
  }
}

