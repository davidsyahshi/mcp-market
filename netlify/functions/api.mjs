// One Netlify function serves everything dynamic: /mcp, OAuth, sign-in pages, /api/*, /admin/*.
// Routing lives in netlify.toml; the code lives in server/src.
import { createHandler } from '../../server/src/lambda.js';

export const handler = createHandler();
