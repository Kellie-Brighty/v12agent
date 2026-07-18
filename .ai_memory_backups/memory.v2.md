# Project State & Memory

## Current Objective
- [ ] *No goal set yet. Please define your current technical objective.*

## Technical Stack & Constraints
- Runtime/Tools: Bun, TypeScript

## Progress & Recent Actions
- [x] Initialized workspace persistence layer via MCP.

## Discovered Gotchas / Context Notes
- *Add key architectural details or breaking changes here.*

### Update: 7/18/2026, 10:26:07 AM
- [x] Initialized project with bun init -y
- [x] Installed all dependencies: @alpacahq/alpaca-trade-api v4.0.1, dotenv v17.4.2, @types/node
- [x] Fixed SDK v4 import (named export), secret field, deep namespace API paths
- [x] Boot sequence fully working - paper account live at $100k cash
- [x] Fixed ClockResp type error: is_open -> clocks[0].isMarketDay

## Discovered Gotchas
- SDK v4 import: `import { Alpaca } from '@alpacahq/alpaca-trade-api'` (named, not default)
- Constructor: use `secret` NOT `secretKey`
- Deep namespacing: `alpaca.trading.account.getAccount()`, `alpaca.trading.clock.clock()`, etc.
- `getAssets()` REMOVED in v4 - use Alpaca MCP `get_all_assets` tool instead
- ClockResp is `{ clocks: Clock[] }` - access `clocks[0]`; field is `isMarketDay` (camelCase), NOT `is_open`
- .env uses custom names ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (not SDK defaults)

### Update: 7/18/2026, 10:44:39 AM
- [x] Built full real-time candlestick chart UI
  - server.ts: Bun WebSocket proxy, connects to Alpaca crypto stream, loads 100 historical 1-min bars on boot, aggregates live trades into current-minute candle, broadcasts to browser clients
  - ui/: Vite React app, CandleChart (Canvas), useAlpacaStream hook, dark terminal design
- [x] Zero TypeScript errors on both server.ts and UI

## How to run
- Terminal 1: `bun run server.ts` (from /v12agent root)
- Terminal 2: `cd ui && bun dev`
- Open http://localhost:5173

## Key architecture notes
- server.ts port 3001 — WebSocket only
- Alpaca stream: wss://stream.data.alpaca.markets/v1beta3/crypto/us
- Subscribed to: bars + trades for BTC/USD, ETH/USD, SOL/USD
- Candle type: { time, open, high, low, close, volume }
- Client message types: init | bar | tick

### Update: 7/18/2026, 7:47:39 PM
- [x] Fixed all TypeScript `strictNullChecks` issues across `server.ts` and `bot.ts`.
- [x] Added `"DOM"` to `"lib"` in `tsconfig.json` to resolve UI errors at the root level.
- [x] **CRITICAL:** Migrated the Higher Timeframe (HTF) market bias calculation from `1Hour` to `15Min` bars. As noticed by the user, 1Hour structure is too slow and unresponsive for 1-minute execution setups. The 15Min chart provides much more relevant "internal range liquidity" bias for intraday scalps.

### Update: 7/18/2026, 9:28:50 PM
Implemented Brain self-learning layer. Integrated Firebase Admin SDK to log trades/observations to Firestore ('blackeagleonsol' project). Integrated DeepSeek API via 'openai' package for micro-reflection upon losing trades. Refactored bot.ts to use a dynamic Proxy configuration powered by learned_config.json updated by the LLM.
