# V12Agent (Version 1.0.0)
An automated, self-learning quantitative trading framework built with **Node.js** and **TypeScript**. V12Agent connects directly to the **Alpaca API** to backtest, paper trade, and execute algorithmic strategies across highly liquid US equities and major cryptocurrencies.

---

## 🏗️ System Architecture

┌────────────────────────┐
                   │   Alpaca Market Data   │
                   │   (Rest / WebSockets)  │
                   └───────────┬────────────┘
                               │
                               ▼ (Live Ticks / Historic Bars)
                   ┌────────────────────────┐
                   │      V12Agent Brain    │
                   │   (Custom ML Memory)   │
                   └───────────┬────────────┘
                               │
                               ▼ (Raw Trade Decisions)
                   ┌────────────────────────┐
                   │ Risk & Position Guard  │
                   │ (Hard Rules / Stops)   │
                   └───────────┬────────────┘
                               │
                               ▼ (Validated Safe Executions)
                   ┌────────────────────────┐
                   │  Alpaca Client Engine  │
                   │   (Paper Dashboard)    │
                   └────────────────────────┘

                   V12Agent cleanly separates state tracking from operational logic using three independent components:
1. **The Brain (Memory Pipeline):** Evaluates incoming market structures, tracks historic indicators, and adapts trading policies.
2. **The Guardrail Layer:** Intercepts raw model intents, applying position sizing thresholds, capital constraints, and emergency stops before hitting the market.
3. **The Broker Client:** Manages stateless API execution and real-time socket connections with Alpaca.

---

## 🎛️ Project Checklist

- [ ] Initialize repository structure and TypeScript environment.
- [ ] Connect and authenticate with the Alpaca Paper Trading endpoint.
- [ ] Stream real-time price feeds for target assets (e.g., BTC, ETH, SOL).
- [ ] Implement the core internal memory matrix for state adjustments.
- [ ] Run zero-risk paper trade executions driven by model memory loops.

---

## 🚀 Getting Started

### 1. Project Initialization
Run the following commands in your Mac terminal to instantiate the V12Agent environment:

```bash
# Set up project space
mkdir v12agent && cd v12agent
npm init -y

# Install official Alpaca SDK and TypeScript tooling
npm install @alpacahq/alpaca-trade-api
npm install -D typescript @types/node ts-node
npx tsc --init