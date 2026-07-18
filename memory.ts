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
  // Don't crash immediately, let the bot run even if memory is offline initially
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
 * Logs a completed trade event (win or loss) to Firestore, capturing the local context.
 */
export async function logTradeEvent(context: TradeContext, outcome: 'win' | 'loss', candles: Candle[]) {
  if (!db) return;
  try {
    const docRef = db.collection('trades').doc();
    await docRef.set({
      timestamp: FieldValue.serverTimestamp(),
      type: 'trade_closed',
      context,
      outcome,
      // We stringify the candles array to prevent massive nested maps in Firestore
      // which can hit index limits or depth limits.
      candlesSnapshot: JSON.stringify(candles)
    });
    console.log(`🧠 [MEMORY] Logged ${outcome} trade for ${context.symbol} to Firebase.`);
    
    // Trigger Micro-Reflection for both wins and losses
    if (outcome === 'loss' || outcome === 'win') {
      const { triggerMicroReflection } = await import('./brain.ts');
      triggerMicroReflection('trade_closed', context, outcome, candles).catch(console.error);
    }
  } catch (error) {
    console.error('Failed to log trade event to memory:', error);
  }
}

/**
 * Logs an observation event (e.g. major sweep without entry) to Firestore.
 */
export async function logObservationEvent(description: string, symbol: string, candles: Candle[]) {
  if (!db) return;
  try {
    const docRef = db.collection('observations').doc();
    await docRef.set({
      timestamp: FieldValue.serverTimestamp(),
      type: 'observation',
      description,
      symbol,
      candlesSnapshot: JSON.stringify(candles)
    });
    console.log(`🧠 [MEMORY] Logged observation for ${symbol} to Firebase.`);
    
    // Trigger Micro-Reflection for observations
    const { triggerMicroReflection } = await import('./brain.ts');
    triggerMicroReflection('observation', { symbol, entryPrice: 0, stopLoss: 0, takeProfit: 0, setupType: 'other', htfBias: 'unknown', killZone: 'unknown' }, 'none', candles).catch(console.error);
  } catch (error) {
    console.error('Failed to log observation event to memory:', error);
  }
}
