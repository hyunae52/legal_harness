import type { CitationInput, IssueAnalysisInput } from './researchContracts.js';

/** Current conclusions include timing and counter resolution, regardless of citation placement.
 * Subsequent-treatment citations alone document case history; adopting that authority as a
 * current ground is expressed here or by applied/analogy, and opens its own follow-up work. */
export function substantiveCitations(analysis: IssueAnalysisInput): CitationInput[] {
  return [...analysis.claims.flatMap(c => c.citations),
    ...(analysis.legal_basis?.temporal_application.citations ?? []),
    ...analysis.counter_evidence.flatMap(c => c.resolution_citations ?? [])];
}
