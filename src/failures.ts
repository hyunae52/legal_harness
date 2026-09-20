import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { type Actor, digest, type FailureService, ServiceError } from './contracts.js';

// No arbitrary free text leaves this intake. Known case ids expand to synthetic
// reproductions in a trusted catalog; original legal cases need a private workflow.
export const FailureSchema = z.object({ request_id: z.string().uuid(), case_id: z.enum(['FC-01','FC-02','FC-03','FC-04','FC-05','FC-06','FC-07','FC-08','FC-09','FC-10','INPUT-BOOLEAN-01']),
  category: z.enum(['retrieval','validation','transport']), expected: z.enum(['needs_info','retrieval','reject_invalid_input']),
  actual: z.enum(['passed','empty','error','accepted_invalid_input']) }).strict();
const subject = (actor: Actor) => {
  if (actor.kind === 'auth_user' && actor.id === `user:${actor.userId}`) return z.string().uuid().parse(actor.userId);
  if (actor.kind === 'api_client' && actor.id === 'api:partner') return 'partner';
  throw new ServiceError(401, 'INVALID_ACTOR');
};
export function createFailureService(db: Pick<SupabaseClient, 'rpc'>): FailureService {
  async function call(name: string, args: Record<string, unknown>) {
    let result;
    try { result = await db.rpc(name, args); } catch { throw new ServiceError(503,'DB_UNAVAILABLE'); }
    if (result.error) {
      if (result.error.code === '23505') throw new ServiceError(409,'IDEMPOTENCY_CONFLICT');
      if (result.error.code === '54000') throw new ServiceError(429,'QUEUE_CAPACITY');
      throw new ServiceError(503,'DB_UNAVAILABLE');
    }
    return result.data;
  }
  return {
    async submit(actor, input) {
      const {request_id, ...payload} = FailureSchema.parse(input);
      const result = await call('harness_submit_failure',{p_kind:actor.kind,p_subject:subject(actor),p_request:request_id,p_hash:digest(payload),p_payload:payload});
      return z.object({receipt_id:z.string().uuid(),job_id:z.string().uuid(),status:z.string(),duplicate:z.boolean()}).strict().parse(result);
    },
    async status(actor,id) {
      const result = await call('harness_failure_status',{p_kind:actor.kind,p_subject:subject(actor),p_id:z.string().uuid().parse(id)});
      if (!result) throw new ServiceError(404,'RECEIPT_NOT_FOUND');
      return z.object({receipt_id:z.string().uuid(),job_id:z.string().uuid(),status:z.string(),attempt:z.number().int()}).strict().parse(result);
    },
  };
}
export function configuredFailureService(env: NodeJS.ProcessEnv): FailureService | undefined {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return undefined;
  const db = createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(5000)})}});
  return createFailureService(db);
}
