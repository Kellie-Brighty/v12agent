import { useState } from 'react';
import { useAlpacaStream } from './hooks/useAlpacaStream';
import { CandleChart } from './components/CandleChart';
import { SYMBOLS } from './types';
import type { AssetSymbol } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtPrice(p?: number): string {
  if (!p) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

function ticker(s: AssetSymbol) { return s.split('/')[0]; }

// ─── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [active, setActive] = useState<AssetSymbol>('BTC/USD');
  const { candles, latestPrices, connected } = useAlpacaStream();

  const symbolCandles = candles[active] ?? [];
  const latestPrice   = latestPrices[active];
  const lastCandle    = symbolCandles[symbolCandles.length - 1];
  const firstCandle   = symbolCandles[0];

  const displayPrice  = latestPrice ?? lastCandle?.close;
  const openPrice     = firstCandle?.open;
  const changeAmt     = displayPrice && openPrice ? displayPrice - openPrice : null;
  const changePct     = changeAmt && openPrice ? (changeAmt / openPrice) * 100 : null;
  const isUp          = (changePct ?? 0) >= 0;

  const dayHigh = symbolCandles.length > 0 ? Math.max(...symbolCandles.map(c => c.high))   : undefined;
  const dayLow  = symbolCandles.length > 0 ? Math.min(...symbolCandles.map(c => c.low))    : undefined;
  const totalVol = symbolCandles.reduce((a, c) => a + (c.volume ?? 0), 0);

  return (
    <div className="app">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <span className="logo">V12Agent</span>
          <div className="status">
            <span className={`dot ${connected ? 'live' : 'dead'}`} />
            <span className="status-label">{connected ? 'Live' : 'Connecting…'}</span>
          </div>
        </div>

        <nav className="tabs">
          {SYMBOLS.map(s => (
            <button
              key={s}
              className={`tab ${active === s ? 'active' : ''}`}
              onClick={() => setActive(s)}
            >
              {ticker(s)}
            </button>
          ))}
        </nav>
      </header>

      {/* ── Ticker bar ──────────────────────────────────────────────────── */}
      <div className="ticker">
        <div className="ticker-left">
          <span className="symbol-label">{active}</span>
          <span className="price">${fmtPrice(displayPrice)}</span>
          {changePct !== null && (
            <span className={`badge ${isUp ? 'up' : 'down'}`}>
              {isUp ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>

        <div className="ticker-stats">
          <div className="stat"><span className="sl">H</span><span className="sv">${fmtPrice(dayHigh)}</span></div>
          <div className="stat"><span className="sl">L</span><span className="sv">${fmtPrice(dayLow)}</span></div>
          <div className="stat"><span className="sl">Vol</span><span className="sv">{totalVol.toFixed(4)}</span></div>
          <div className="stat"><span className="sl">Bars</span><span className="sv">{symbolCandles.length}</span></div>
        </div>
      </div>

      {/* ── Chart ───────────────────────────────────────────────────────── */}
      <main className="chart-wrap">
        {symbolCandles.length > 0 ? (
          <CandleChart candles={symbolCandles} symbol={active} />
        ) : (
          <div className="loading">
            <div className="spinner" />
            <p>Loading {active} candles…</p>
            {!connected && <p className="warn">⚠ Not connected to server — run <code>bun run server.ts</code></p>}
          </div>
        )}
      </main>

    </div>
  );
}
