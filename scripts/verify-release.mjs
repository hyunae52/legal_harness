// Read-only gate. This does not activate a release or execute artifact scripts.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Octokit} from '@octokit/rest';
import {BatchManifestSchema,verifyRelease} from '../dist/releaseGate.js';
const [manifestFile,artifact,commentArg]=process.argv.slice(2);
if(!manifestFile||!artifact||!/^\d+$/.test(commentArg??'')||!process.env.GITHUB_OPERATOR)throw Error('Usage: npm run release:verify -- manifest.json artifact.tgz APPROVAL_COMMENT_ID; set GITHUB_OPERATOR');
const m=BatchManifestSchema.parse(JSON.parse(await readFile(manifestFile,'utf8'))),[owner,repo]=m.repository.split('/');
const gh=new Octokit({auth:process.env.GITHUB_TOKEN,request:{timeout:15000}}),where={owner,repo};
const [{data:pr},{data:comment},{data:run},{data:main}]=await Promise.all([
  gh.rest.pulls.get({...where,pull_number:m.pr_number}),gh.rest.issues.getComment({...where,comment_id:Number(commentArg)}),
  gh.rest.actions.getWorkflowRunAttempt({...where,run_id:m.run_id,attempt_number:m.run_attempt}),gh.rest.git.getRef({...where,ref:'heads/main'}),
]);
if(comment.issue_url!==`https://api.github.com/repos/${owner}/${repo}/issues/${m.pr_number}`)throw Error('Approval comment belongs to a different batch');
if(!pr.merge_commit_sha)throw Error('Batch is not merged');
const {data:merge}=await gh.rest.git.getCommit({...where,commit_sha:pr.merge_commit_sha});
const jobs=await gh.paginate(gh.rest.actions.listJobsForWorkflowRunAttempt,{...where,run_id:m.run_id,attempt_number:m.run_attempt,per_page:100});
const components=[];
for(const component of m.components) {const {data:p}=await gh.rest.pulls.get({...where,pull_number:component.pr});components.push({pr:component.pr,head:p.head.sha});}
const evidence={approval:{author:comment.user?.login,body:comment.body},operator:process.env.GITHUB_OPERATOR,
  pr:{merged:pr.merged,head:pr.head.sha,base:pr.base.sha,merge:pr.merge_commit_sha},merge:{sha:merge.sha,parents:merge.parents.map(p=>p.sha),tree:merge.tree.sha},main:main.object.sha,
  artifact_sha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),
  run:{id:run.id,attempt:run.run_attempt,workflow_id:run.workflow_id,head:run.head_sha,path:run.path,status:run.status,conclusion:run.conclusion},jobs,components};
console.log(JSON.stringify(verifyRelease(m,evidence),null,2));
