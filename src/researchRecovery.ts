import { ServiceError } from './contracts.js';

export type CapacityReason = 'sessions' | 'actor_sessions' | 'attempts' | 'jobs' | 'receipts'
  | 'body_bytes' | 'ledger_bytes' | 'session_bytes' | 'shared_bytes' | 'shared_reservation' | 'response_bytes';
/** Only server-built, already authorized diagnostic fields may cross the public boundary. */
export class ResearchCapacityError extends ServiceError {
  constructor(public readonly capacity_reason: CapacityReason, public readonly recovery: Record<string, unknown>,
    code = 'RESEARCH_CAPACITY') { super(429, code); }
  publicBody() { return { code: this.code, capacity_reason: this.capacity_reason, recovery: this.recovery }; }
}
