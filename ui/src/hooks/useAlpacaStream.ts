import { useState, useEffect, useRef, useCallback } from 'react';
import { SYMBOLS } from '../types';
import type { Candle, ServerMessage } from '../types';

interface StreamState {
  candles:      Record<string, Candle[]>;
  latestPrices: Record<string, number>;
  connected:    boolean;
}

const initCandles = Object.fromEntries(SYMBOLS.map(s => [s, [] as Candle[]]));

export function useAlpacaStream() {
  const [state, setState] = useState<StreamState>({
    candles:      initCandles,
    latestPrices: {},
    connected:    false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket('ws://localhost:3001');
    wsRef.current = ws;

    ws.onopen = () => setState(prev => ({ ...prev, connected: true }));

    ws.onclose = () => {
      setState(prev => ({ ...prev, connected: false }));
      retryRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data as string);

      setState(prev => {
        // ── init snapshot ─────────────────────────────────────────────────
        if (msg.type === 'init') {
          return { ...prev, candles: { ...prev.candles, [msg.symbol]: msg.candles } };
        }

        // ── completed bar ─────────────────────────────────────────────────
        if (msg.type === 'bar') {
          const existing = prev.candles[msg.symbol] ?? [];
          const updated  = [...existing, msg.candle].slice(-100);
          return { ...prev, candles: { ...prev.candles, [msg.symbol]: updated } };
        }

        // ── live tick → update/create live candle ─────────────────────────
        if (msg.type === 'tick') {
          const existing   = [...(prev.candles[msg.symbol] ?? [])];
          const minuteTime = Math.floor(msg.time / 60) * 60;
          const lastIdx    = existing.length - 1;

          if (lastIdx >= 0 && existing[lastIdx]!.time === minuteTime) {
            const last = { ...existing[lastIdx]! };
            last.high  = Math.max(last.high,  msg.price);
            last.low   = Math.min(last.low,   msg.price);
            last.close = msg.price;
            existing[lastIdx] = last;
          } else {
            const prevClose = lastIdx >= 0 ? existing[lastIdx]!.close : msg.price;
            existing.push({ time: minuteTime, open: prevClose, high: msg.price, low: msg.price, close: msg.price, volume: 0 });
          }

          return {
            ...prev,
            candles:      { ...prev.candles, [msg.symbol]: existing.slice(-100) },
            latestPrices: { ...prev.latestPrices, [msg.symbol]: msg.price },
          };
        }

        return prev;
      });
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
