import type { ServerWebSocket } from 'bun';
import * as dotenv from 'dotenv';
dotenv.config();
import { onBar } from './bot';

const API_KEY    = process.env.ALPACA_API_KEY_ID!;
const API_SECRET = process.env.ALPACA_API_SECRET_KEY!;
const STREAM_URL = 'wss://stream.data.alpaca.markets/v1beta3/crypto/us';
const DATA_URL   = 'https://data.alpaca.markets/v1beta3/crypto/us';
const SYMBOLS    = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const;
const MAX_CANDLES = 100;
const PORT        = 3001;

interface Candle {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

type ToClient =
  | { type: 'init'; symbol: string; candles: Candle[] }
  | { type: 'bar';  symbol: string; candle:  Candle  }
  | { type: 'tick'; symbol: string; price: number; time: number };

const store:    Record<string, Candle[]>      = {};
const htfStore: Record<string, Candle[]>      = {}; // 1-Hour bars — used for bias
const live:     Record<string, Candle | null>  = {};
SYMBOLS.forEach(s => { store[s] = []; htfStore[s] = []; live[s] = null; });

const clients = new Set<ServerWebSocket<undefined>>();

function broadcast(msg: ToClient) {
  const json = JSON.stringify(msg);
  Array.from(clients).forEach(ws => ws.send(json));
}

async function fetchBars(symbol: string, timeframe = '1Min', limit = MAX_CANDLES): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbols: symbol, timeframe, limit: String(limit), sort: 'asc',
  });
  const res = await fetch(`${DATA_URL}/bars?${params}`, {
    headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET },
  });
  if (!res.ok) { console.error(`  ⚠️  Failed bars for ${symbol} (${timeframe}):`, res.status); return []; }
  interface RawBar { t: string; o: number; h: number; l: number; c: number; v: number; }
  const data = await res.json() as { bars?: Record<string, RawBar[]> };
  return (data.bars?.[symbol] ?? []).map((b) => ({
    time: Math.floor(new Date(b.t).getTime() / 1000),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

async function refreshHTFBars(): Promise<void> {
  for (const s of SYMBOLS) {
    const bars = await fetchBars(s, '1Hour', 50);
    if (bars.length > 0) htfStore[s] = bars;
  }
}

let alpacaWs: WebSocket | null = null;

function connectStream() {
  alpacaWs = new WebSocket(STREAM_URL);

  alpacaWs.onopen = () => console.log('🔗 Alpaca stream connected.');

  alpacaWs.onmessage = (event) => {
    interface AlpacaMsg { T: string; msg?: string; S?: string; t?: string; o?: number; h?: number; l?: number; c?: number; v?: number; p?: number; s?: number; }
    const messages: AlpacaMsg[] = JSON.parse(event.data as string);
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'connected') {
        alpacaWs!.send(JSON.stringify({ action: 'auth', key: API_KEY, secret: API_SECRET }));
      } else if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('✅ Authenticated. Subscribing...');
        alpacaWs!.send(JSON.stringify({ action: 'subscribe', bars: [...SYMBOLS], trades: [...SYMBOLS] }));
      } else if (msg.T === 'b') {
        const symbol = msg.S!;
        const candle: Candle = {
          time: Math.floor(new Date(msg.t!).getTime() / 1000),
          open: msg.o!, high: msg.h!, low: msg.l!, close: msg.c!, volume: msg.v!,
        };
        (store[symbol] ??= []).push(candle);
        if ((store[symbol] ??= []).length > MAX_CANDLES) store[symbol]?.shift();
        live[symbol] = null;
        broadcast({ type: 'bar', symbol, candle });
        // ── Run ICT bot after every completed bar ──────────────────────────
        onBar(symbol, store[symbol] ?? [], htfStore[symbol] ?? []).catch(console.error);
      } else if (msg.T === 't') {
        const symbol = msg.S!;
        const price  = msg.p!;
        const time   = Math.floor(new Date(msg.t!).getTime() / 1000);
        const minuteTime     = Math.floor(time / 60) * 60;
        const prev = live[symbol];
        const symbolStore = (store[symbol] ?? []);
        if (!prev || prev.time !== minuteTime) {
          const lastClose = symbolStore.length > 0 ? symbolStore[symbolStore.length - 1]?.close ?? price : price;
          live[symbol] = { time: minuteTime, open: lastClose, high: price, low: price, close: price, volume: msg.s ?? 0 };
        } else {
          prev.high   = Math.max(prev.high, price);
          prev.low    = Math.min(prev.low,  price);
          prev.close  = price;
          prev.volume = (prev.volume ?? 0) + (msg.s ?? 0);
        }
        broadcast({ type: 'tick', symbol, price, time });
      }
    }
  };

  alpacaWs.onclose = () => { console.log('⚠️  Stream closed. Reconnecting in 3 s...'); setTimeout(connectStream, 3000); };
  alpacaWs.onerror = () => console.error('❌ Alpaca stream error. Will reconnect on close.');
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', symbols: SYMBOLS }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    return new Response('V12Agent WebSocket Server', { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`🔌 Browser connected   (total: ${clients.size})`);
      for (const symbol of SYMBOLS) {
        const snap = [...(store[symbol] ?? []), ...(live[symbol] ? [live[symbol]!] : [])];
        ws.send(JSON.stringify({ type: 'init', symbol, candles: snap }));
      }
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(raw as string);
        if (msg.type === 'subscribe' && msg.symbol && store[msg.symbol]) {
          const snap = [...(store[msg.symbol] ?? []), ...(live[msg.symbol] ? [live[msg.symbol]!] : [])];
          ws.send(JSON.stringify({ type: 'init', symbol: msg.symbol, candles: snap }));
        }
      } catch { /* ignore */ }
    },
    close(ws) { clients.delete(ws); console.log(`🔌 Browser disconnected (total: ${clients.size})`); },
  },
});

async function start() {
  console.log('🔄 Loading historical 1-min bars...');
  await Promise.all(SYMBOLS.map(async (s) => {
    store[s] = await fetchBars(s);
    console.log(`  📊 ${s}: ${store[s].length} bars`);
  }));

  console.log('🔄 Loading 1-hour HTF bars (for bias)...');
  await refreshHTFBars();
  for (const s of SYMBOLS) {
    console.log(`  📈 ${s}: ${htfStore[s]!.length} 1H bars`);
  }

  // Refresh HTF bars every hour
  setInterval(() => {
    refreshHTFBars().catch(console.error);
    console.log('🔁 HTF bars refreshed');
  }, 60 * 60 * 1000);

  connectStream();
  console.log(`\n🚀 V12Agent proxy live on ws://localhost:${server.port}\n`);
}

start().catch(console.error);
