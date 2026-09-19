import {Octokit} from '@octokit/rest';
import {validatePublicPatch,type Patch,type EvolutionJob} from './evolution.js';
import {digest,ServiceError} from './contracts.js';
import {z} from 'zod';

export interface GitOpsOptions {token:string;owner:string;repo:string;baseBranch:string}
// Only a trusted coordinator supplies this port. It records an outbox intent
// before entering this function, and marks any thrown/unknown result ambiguous.
export async function publishReviewedPatch(options:GitOpsOptions,job:EvolutionJob,input:Patch,reviewedHead:string,client?:Octokit) {
  if(!options.token) throw new ServiceError(503,'GITHUB_NOT_CONFIGURED');
  const patch=validatePublicPatch(input);
  z.string().uuid().parse(job.id);z.string().regex(/^[a-f0-9]{40}$/).parse(job.base_sha);
  z.string().regex(/^[a-f0-9]{40}$/).parse(reviewedHead);
  const octokit=client??new Octokit({auth:options.token,request:{timeout:15000}});
  const {owner,repo}=options,branch=`auto-fix-${job.id}`;
  const existing=await octokit.rest.pulls.list({owner,repo,head:`${owner}:${branch}`,state:'all',per_page:100});
  if(existing.data.length>1)throw new ServiceError(409,'AMBIGUOUS_PR');
  const prior=existing.data[0];
  if(prior && (prior.head.sha!==reviewedHead || prior.base.ref!==options.baseBranch || prior.state!=='open' || prior.merged_at))throw new ServiceError(409,'PR_HEAD_OR_STATE_CHANGED');
  // The tested immutable commit must already exist from the isolated staging
  // workflow. Publishing must never create a different, untested commit.
  const ref=await octokit.rest.git.getRef({owner,repo,ref:`heads/${branch}`});
  if(ref.data.object.sha!==reviewedHead)throw new ServiceError(409,'REVIEWED_HEAD_MISMATCH');
  const comparison=await octokit.rest.repos.compareCommits({owner,repo,base:job.base_sha,head:reviewedHead});
  const files=comparison.data.files??[];
  if(files.length!==patch.files.length||comparison.data.total_commits!==1)throw new ServiceError(409,'PATCH_COMPARISON_MISMATCH');
  for(const file of patch.files) {
    if(!files.some(f=>f.filename===file.path && ['added','modified'].includes(f.status)))throw new ServiceError(409,'PATCH_COMPARISON_MISMATCH');
    const blob=await octokit.rest.repos.getContent({owner,repo,path:file.path,ref:reviewedHead});
    if(Array.isArray(blob.data)||!('content' in blob.data)||Buffer.from(blob.data.content,'base64').toString('utf8')!==file.content)throw new ServiceError(409,'PATCH_CONTENT_MISMATCH');
  }
  if(prior)return {status:'published' as const,url:prior.html_url};
  try {
    const pr=await octokit.rest.pulls.create({owner,repo,head:branch,base:options.baseBranch,draft:true,
      title:`[Auto-Fix] ${job.id}`,body:`Synthetic failure patch.\n\nBase: ${job.base_sha}\nHead: ${reviewedHead}\nExecution: ${job.execution_hash}\nPatch: ${digest(patch)}\n\nIndependent evidence is recorded by the coordinator. Final human batch review is required.`});
    return {status:'published' as const,url:pr.data.html_url};
  } catch {return {status:'unknown' as const};}
}
