// Scheduled entry (Netlify scheduled function, see netlify.toml): every few minutes, keep the Helius webhook
// in sync, credit any deposit the webhook missed, and pay queued withdrawals. Safe to run any number of times.
import { openPg } from './pg.js';
import { migrate } from './schema.js';
import { createDeposits } from './deposits.js';
import { createWithdrawals } from './withdrawals.js';
import { createExplorer } from './explorer.js';

export function createCronHandler(opts = {}) {
  let ready = null;
  const init = async () => {
    const db = opts.db || openPg(process.env.DATABASE_URL, { max: 2 });
    await migrate(db);
    const deposits = opts.deposits || createDeposits(db, { publicUrl: opts.publicUrl, rpc: opts.rpc, helius: opts.helius, config: opts.depositConfig });
    const withdrawals = opts.withdrawals || createWithdrawals(db, { rpc: opts.rpc, config: opts.withdrawConfig });
    const explorer = opts.explorer || createExplorer(db, { deposits, withdrawals, rpc: opts.rpc, config: opts.explorerConfig });
    return { deposits, withdrawals, explorer };
  };
  return async (event, context) => {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    ready ??= init().catch((e) => { ready = null; throw e; });
    const { deposits, withdrawals, explorer } = await ready;
    // Netlify gives a scheduled run 30 seconds: deposits, then withdrawals, then the explorer's chain and reserves
    const out = deposits.enabled ? await deposits.tick({ budgetMs: opts.budgetMs ?? 11_000 }) : { skipped: deposits.problem };
    console.log('deposits tick', JSON.stringify(out));
    out.withdrawals = withdrawals.enabled ? await withdrawals.tick({ budgetMs: opts.budgetMs ?? 10_000 }) : { skipped: withdrawals.problem };
    console.log('withdrawals tick', JSON.stringify(out.withdrawals));
    out.explorer = await explorer.tick({ budgetMs: opts.explorerBudgetMs ?? 5_000 });
    console.log('explorer tick', JSON.stringify(out.explorer));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  };
}
