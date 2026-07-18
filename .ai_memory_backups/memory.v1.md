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
