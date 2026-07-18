import { Alpaca } from '@alpacahq/alpaca-trade-api';
import * as dotenv from 'dotenv';

dotenv.config();

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY_ID,
  secret: process.env.ALPACA_API_SECRET_KEY,
  paper: process.env.ALPACA_ENV_PAPER === 'true',
});

async function bootV12Agent() {
  try {
    console.log('🔄 Initializing V12Agent connection protocols...');
    
    // Validate connection credentials via account endpoint
    const account = await alpaca.trading.account.getAccount();
    console.log(`✅ Connection established successfully.`);
    console.log(`💰 Available Paper Cash Portfolio: $${account.cash}`);
    console.log(`📈 Equity: $${account.equity} | Buying Power: $${account.buying_power}`);

    // Confirm market data API connectivity via clock
    const clockResp = await alpaca.trading.clock.clock();
    const clock = clockResp.clocks?.[0];
    const marketStatus = clock?.isMarketDay ? `🟢 OPEN (${clock.phase})` : '🔴 CLOSED';
    console.log(`🕐 Market Status: ${marketStatus}`);
    console.log(`📊 V12Agent environment initialized. Ready to deploy strategies.`);
    
  } catch (error: any) {
    console.error('❌ V12Agent Initialization Failure:', error.message);
  }
}

bootV12Agent();