import type { Request } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Actor } from './contracts.js';
import { ServiceError } from './contracts.js';
import { PublicAccess } from './publicAccess.js';

export function createAuthenticator(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch, publicAccess = new PublicAccess(env)) {
  const client = env.SUPABASE_URL && (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY)
    ? createClient(env.SUPABASE_URL, (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY)!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => transport(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    }) : undefined;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return async (req: Request): Promise<Actor> => {
    if (req.query.apiKey !== undefined) throw new ServiceError(401, 'QUERY_AUTH_REMOVED');
    if (req.get('authorization') === undefined && req.get('x-api-key') === undefined) return publicAccess.anonymous(req);
    const bearer = /^Bearer (\S+)$/i.exec(req.get('authorization') || '')?.[1];
    const apiKey = req.get('x-api-key');
    const supplied = apiKey || bearer;
    if (supplied && env.TAXLAB_API_KEY && timingSafeEqual(hash(supplied), hash(env.TAXLAB_API_KEY))) {
      return { id: 'api:partner', kind: 'api_client' };
    }
    if (apiKey) throw new ServiceError(401, 'UNAUTHORIZED');
    if (bearer && client) {
      try {
        const { data, error } = await client.auth.getUser(bearer);
        if (!error && data.user) return { id: `user:${data.user.id}`, kind: 'auth_user', userId: data.user.id };
      } catch { throw new ServiceError(503, 'AUTH_UNAVAILABLE'); }
    }
    throw new ServiceError(401, 'UNAUTHORIZED');
  };
}
