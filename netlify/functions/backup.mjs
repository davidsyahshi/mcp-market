// Scheduled every 2 hours (the schedule is below): copies the database into Netlify Blobs, see server/src/backup.js.
// A modern (v2) function, so Netlify Blobs is set up for it automatically.
import { runScheduledBackup } from '../../server/src/backup.js';

export default async () => {
  const status = await runScheduledBackup();
  return new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '17 */2 * * *' };
