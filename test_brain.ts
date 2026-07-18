import { logTradeEvent } from './memory';
import { Candle } from './bot';

async function run() {
  console.log('🧪 Simulating a fake losing trade to test the Brain...');

  const fakeCandles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    fakeCandles.push({
      time: Math.floor(Date.now() / 1000) - (50 - i) * 60,
      open: 65000,
      high: 65100,
      low: 64900,
      close: 65050,
      volume: 100
    });
  }

  // Adding a final candle that drastically breaks structure (the "fake out")
  fakeCandles.push({
    time: Math.floor(Date.now() / 1000),
    open: 65050,
    high: 65150,
    low: 64500, // Massive wick down
    close: 64600,
    volume: 5000
  });

  await logTradeEvent({
    symbol: 'BTC/USD',
    entryPrice: 65050,
    stopLoss: 64950,
    takeProfit: 65500,
    setupType: 'bullish_fvg',
    htfBias: 'bullish',
    killZone: 'London Open'
  }, 'loss', fakeCandles);

  console.log('⏳ Waiting 10 seconds for DeepSeek to process micro-reflection...');
  setTimeout(() => process.exit(0), 10000);
}

run();
