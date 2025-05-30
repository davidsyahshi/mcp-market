// Scheduled every 5 minutes (netlify.toml): picks up USDC/USDT deposits the Helius webhook missed
// and keeps the webhook's address list in sync. The code lives in server/src/cron.js.
import { createCronHandler } from '../../server/src/cron.js';

export const handler = createCronHandler();
