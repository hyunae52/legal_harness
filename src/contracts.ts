import { createHash } from 'node:crypto';
import { z } from 'zod';

export const digest = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export class ServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
// Validate nonblank content without normalizing it: receipts bind the exact
// submitted draft, including Markdown whitespace and line breaks.
const DraftText=z.string().min(1).max(50_000).refine(s=>s.trim().length>0,'Draft must not be blank');
export const DraftSchema = z.object({
  draft_answer: DraftText,
  query: z.string().max(20_000).optional(),
  facts: z.record(z.unknown()).default({}),
  skip_gates: z.array(z.string().max(80)).max(10).default([]),
  bypass_reason: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(['strict', 'warn']).default('strict'),
  force: z.boolean().default(false),
}).strict().superRefine((v, ctx) => {
  if ((v.force || v.mode === 'warn' || v.skip_gates.length) && !v.bypass_reason) ctx.addIssue({ code: 'custom', path: ['bypass_reason'], message: 'An explicit bypass reason is required.' });
});
export type DraftInput = z.input<typeof DraftSchema>;
export const AnalyzeSchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  tool: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128).default('legal_research'),
  arguments: z.record(z.unknown()).default({}),
  draft_answer: DraftText.optional(),
  facts: z.record(z.unknown()).default({}),
  skip_gates: z.array(z.string().max(80)).max(10).default([]),
  bypass_reason: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(['strict', 'warn']).default('strict'),
  force: z.boolean().default(false),
  event_dates: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default({}),
}).strict();

export interface Actor { id: string; kind: 'auth_user' | 'api_client'; userId?: string }
export interface FailureService {
  submit(actor: Actor, input: unknown): Promise<Record<string, unknown>>;
  status(actor: Actor, id: string): Promise<Record<string, unknown>>;
}
