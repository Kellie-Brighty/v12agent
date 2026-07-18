export interface Candle {
  time:   number; // unix seconds
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export const SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const;
export type AssetSymbol = typeof SYMBOLS[number];

export type ServerMessage =
  | { type: 'init'; symbol: string; candles: Candle[] }
  | { type: 'bar';  symbol: string; candle:  Candle  }
  | { type: 'tick'; symbol: string; price: number; time: number };
