import { useRef, useEffect, useCallback, useState } from 'react';
import type { Candle } from '../types';

interface Props {
  candles: Candle[];
  symbol:  string;
}

// ─── Colours ────────────────────────────────────────────────────────────────
const C = {
  bg:           '#0a0c11',
  grid:         'rgba(255,255,255,0.04)',
  gridText:     '#3a4060',
  bull:         '#00b37d',
  bear:         '#e83d5a',
  bullFaded:    'rgba(0,179,125,0.50)',
  bearFaded:    'rgba(232,61,90,0.50)',
  liveBg:       'rgba(94,129,244,0.06)',
  liveBorder:   'rgba(94,129,244,0.45)',
  priceLine:    'rgba(94,129,244,0.65)',
  priceBox:     '#5e81f4',
  priceBoxText: '#0a0c11',
  timeText:     '#3a4060',
};

const PAD     = { top: 24, right: 82, bottom: 38, left: 8 };
const MIN_CW  = 3;
const MAX_CW  = 60;
const DEF_CW  = 9;

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtPrice(p: number): string {
  if (p >= 10000) return p.toFixed(2);
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function getStep(cw: number): number {
  return cw + Math.max(1, Math.round(cw * 0.35));
}

// ─── Component ──────────────────────────────────────────────────────────────
export function CandleChart({ candles }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef     = useRef<number>(0);

  // All mutable interaction state lives in refs (no re-renders on interaction)
  const candlesRef      = useRef<Candle[]>([]);
  const cwRef           = useRef(DEF_CW);    // candle width = zoom level
  const offsetRef       = useRef(0);          // bars from right edge (0 = latest)
  const prevLenRef      = useRef(0);          // track candle count changes
  const isDragging      = useRef(false);
  const dragStartX      = useRef(0);
  const dragStartOffset = useRef(0);

  // Only this needs a re-render (for the "Jump to Live" button)
  const [isHistorical, setIsHistorical] = useState(false);

  // ── Core draw function — reads all live data from refs ──────────────────
  const draw = useCallback(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    const data      = candlesRef.current;
    if (!canvas || !container || data.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = container.clientWidth;
    const H   = container.clientHeight;

    // Resize canvas if needed
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width        = W * dpr;
      canvas.height       = H * dpr;
      canvas.style.width  = `${W}px`;
      canvas.style.height = `${H}px`;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const chartW = W - PAD.right - PAD.left;
    const chartH = H - PAD.top  - PAD.bottom;

    const cw     = cwRef.current;
    const step   = getStep(cw);
    const offset = Math.max(0, Math.min(offsetRef.current, Math.max(0, data.length - 2)));

    const maxVisible = Math.max(1, Math.floor(chartW / step));
    const endIdx     = Math.max(1, data.length - offset);
    const startIdx   = Math.max(0, endIdx - maxVisible);
    const visible    = data.slice(startIdx, endIdx);

    if (visible.length === 0) return;

    // Price range
    let minP = Infinity, maxP = -Infinity;
    for (const c of visible) {
      if (c.low  < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    }
    const pRange = maxP - minP || minP * 0.01 || 1;
    const pad    = pRange * 0.10;
    const pMin   = minP - pad;
    const pMax   = maxP + pad;
    const pSpan  = pMax - pMin;

    const pToY = (p: number) => PAD.top + chartH - ((p - pMin) / pSpan) * chartH;
    const xOf  = (i: number) => PAD.left + i * step + step / 2;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // ── Grid + price labels ─────────────────────────────────────────────────
    const gridCount = 6;
    ctx.font      = `11px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'left';

    for (let i = 0; i <= gridCount; i++) {
      const p = pMax - (pSpan / gridCount) * i;
      const y = pToY(p);

      ctx.strokeStyle = C.grid;
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + chartW, y); ctx.stroke();

      ctx.fillStyle = C.gridText;
      ctx.fillText(fmtPrice(p), PAD.left + chartW + 6, y + 4);
    }

    // ── Time labels ─────────────────────────────────────────────────────────
    const labelEvery = Math.max(1, Math.ceil(visible.length / 7));
    ctx.fillStyle = C.timeText;
    ctx.font      = `10px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';

    for (let i = 0; i < visible.length; i++) {
      if (i % labelEvery === 0) {
        ctx.fillText(fmtTime(visible[i]!.time), xOf(i), PAD.top + chartH + 24);
      }
    }

    // ── Candles ─────────────────────────────────────────────────────────────
    for (let i = 0; i < visible.length; i++) {
      const c           = visible[i]!;
      const x           = xOf(i);
      const isGreen     = c.close >= c.open;
      const isLive      = i === visible.length - 1 && offset === 0;
      const baseCol     = isGreen ? C.bull     : C.bear;
      const fadedCol    = isGreen ? C.bullFaded : C.bearFaded;

      const highY   = pToY(c.high);
      const lowY    = pToY(c.low);
      const bodyTop = Math.min(pToY(c.open), pToY(c.close));
      const bodyBot = Math.max(pToY(c.open), pToY(c.close));
      const bodyH   = Math.max(1.5, bodyBot - bodyTop);

      // Live candle highlight
      if (isLive) {
        ctx.fillStyle = C.liveBg;
        ctx.fillRect(x - cw / 2 - 3, highY - 4, cw + 6, lowY - highY + 8);
      }

      // Wick
      ctx.strokeStyle = isLive ? fadedCol : baseCol;
      ctx.lineWidth   = cw < 5 ? 1 : 1.5;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, highY); ctx.lineTo(x, lowY); ctx.stroke();

      // Body
      if (isLive) {
        ctx.strokeStyle = C.liveBorder;
        ctx.lineWidth   = 1;
        ctx.strokeRect(x - cw / 2, bodyTop, cw, bodyH);
        ctx.fillStyle   = fadedCol;
      } else {
        ctx.fillStyle = baseCol;
      }
      ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
    }

    // ── Current price dashed line (live only) ───────────────────────────────
    if (offset === 0) {
      const curPrice = visible[visible.length - 1]!.close;
      const curY     = pToY(curPrice);

      ctx.strokeStyle = C.priceLine;
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.moveTo(PAD.left, curY); ctx.lineTo(PAD.left + chartW, curY); ctx.stroke();
      ctx.setLineDash([]);

      const boxX = PAD.left + chartW + 4;
      const boxW = PAD.right - 6;
      const boxH = 20;
      ctx.fillStyle = C.priceBox;
      ctx.beginPath();
      ctx.roundRect(boxX, curY - boxH / 2, boxW, boxH, 4);
      ctx.fill();

      ctx.fillStyle   = C.priceBoxText;
      ctx.font        = `bold 10.5px 'JetBrains Mono', monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(fmtPrice(curPrice), boxX + boxW / 2, curY + 4);
    }
  }, []); // stable — all data accessed through refs

  // ── Sync candlesRef + smart offset when history mode ────────────────────
  useEffect(() => {
    const prev = prevLenRef.current;
    const next = candles.length;

    // Preserve historical viewport when new candles arrive
    if (offsetRef.current > 0 && next > prev) {
      offsetRef.current = Math.min(offsetRef.current + (next - prev), next - 1);
    }

    prevLenRef.current = next;
    candlesRef.current = candles;

    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
  }, [candles, draw]);

  // ── Resize observer ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(draw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // ── Mouse + wheel events (runs once — draw is stable) ───────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fire = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(draw);
    };

    // Zoom via scroll wheel
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      cwRef.current  = Math.max(MIN_CW, Math.min(MAX_CW, cwRef.current * factor));
      fire();
    };

    // Pan via drag
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDragging.current      = true;
      dragStartX.current      = e.clientX;
      dragStartOffset.current = offsetRef.current;
      canvas.style.cursor     = 'grabbing';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const step    = getStep(cwRef.current);
      const dx      = dragStartX.current - e.clientX; // left → older
      const delta   = Math.round(dx / step);
      const maxOff  = Math.max(0, candlesRef.current.length - 1);
      const newOff  = Math.max(0, Math.min(maxOff, dragStartOffset.current + delta));

      if (newOff !== offsetRef.current) {
        offsetRef.current = newOff;
        setIsHistorical(newOff > 0);
        fire();
      }
    };

    const onMouseUp = () => {
      isDragging.current  = false;
      canvas.style.cursor = 'crosshair';
    };

    // Double-click → jump to live
    const onDblClick = () => {
      offsetRef.current = 0;
      setIsHistorical(false);
      fire();
    };

    canvas.addEventListener('wheel',     onWheel,    { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('dblclick',  onDblClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    return () => {
      canvas.removeEventListener('wheel',     onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('dblclick',  onDblClick);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  }, [draw]);

  // ── Jump to live ─────────────────────────────────────────────────────────
  const jumpToLive = useCallback(() => {
    offsetRef.current = 0;
    setIsHistorical(false);
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block', cursor: 'crosshair' }} />

      {isHistorical && (
        <button className="jump-live-btn" onClick={jumpToLive}>
          ▶ Jump to Live
        </button>
      )}

      <div className="chart-hints">
        <span>Scroll to zoom</span>
        <span>·</span>
        <span>Drag to pan</span>
        <span>·</span>
        <span>Double-click to reset</span>
      </div>
    </div>
  );
}
