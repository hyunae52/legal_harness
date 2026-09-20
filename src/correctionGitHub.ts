import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { CorrectionService, correctionContent, correctionFile, type CorrectionRecord, type CorrectionRepository } from './corrections.js';
import { ServiceError } from './contracts.js';

const missing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404;
export function createCorrectionRepository(options: { token: string; owner: string; repo: string; baseBranch: string }, client?: Octokit): CorrectionRepository {
  if (!/^[\w-]+$/.test(options.owner) || !/^[\w.-]+$/.test(options.repo) || options.baseBranch !== 'main') throw new ServiceError(503, 'CORRECTION_REPO_INVALID');
  const api = client ?? new Octokit({ auth: options.token, request: { timeout: 10000 } });
  const scope = { owner: options.owner, repo: options.repo }, target = `${options.owner}/${options.repo}`;
  const branch = (r: CorrectionRecord) => 'correction/' + r.id;
  async function readContent(record: CorrectionRecord, ref: string, signal: AbortSignal) {
    const { data } = await api.rest.repos.getContent({ ...scope, path: correctionFile(record), ref, request: { signal } });
    if (Array.isArray(data) || !('content' in data) || data.encoding !== 'base64') throw new ServiceError(409, 'CORRECTION_CONTENT_CHANGED');
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  async function validateHead(record: CorrectionRecord, head: string, signal: AbortSignal) {
    if (await readContent(record, head, signal) !== correctionContent(record)) throw new ServiceError(409, 'CORRECTION_CONTENT_CHANGED');
    const compared = await api.rest.repos.compareCommits({ ...scope, base: record.base_sha!, head, request: { signal } });
    if (compared.data.status !== 'ahead' || compared.data.behind_by !== 0 || compared.data.total_commits !== 1 || compared.data.files?.length !== 1 || compared.data.files[0].filename !== correctionFile(record) || compared.data.files[0].status !== 'added') throw new ServiceError(409, 'CORRECTION_SCOPE_CHANGED');
  }
  async function find(record: CorrectionRecord, signal: AbortSignal) {
    const { data } = await api.rest.pulls.list({ ...scope, head: `${options.owner}:${branch(record)}`, state: 'all', per_page: 100, request: { signal } });
    if (data.length > 1) throw new ServiceError(409, 'CORRECTION_PR_AMBIGUOUS');
    if (!data.length) return undefined;
    const { data: pr } = await api.rest.pulls.get({ ...scope, pull_number: data[0].number, request: { signal } });
    if (pr.base.ref !== options.baseBranch || pr.head.ref !== branch(record) || pr.head.repo?.full_name !== target ||
      (record.pr && (record.pr.number !== pr.number || record.pr.head_sha !== pr.head.sha))) throw new ServiceError(409, 'CORRECTION_PR_CHANGED');
    await validateHead(record, pr.head.sha, signal);
    return pr;
  }
  return {
    target,
    async base() { return (await api.rest.git.getRef({ ...scope, ref: 'heads/' + options.baseBranch })).data.object.sha; },
    async publish(record) {
      if (record.target_repository !== target || record.base_branch !== options.baseBranch) throw new ServiceError(409, 'CORRECTION_TARGET_CHANGED');
      const signal = AbortSignal.timeout(30000), request = { signal };
      const prior = await find(record, signal);
      if (prior) {
        if (prior.state !== 'open' || prior.merged) throw new ServiceError(409, 'CORRECTION_ALREADY_CLOSED');
        return { number: prior.number, url: prior.html_url, head_sha: prior.head.sha };
      }
      let head: string | undefined;
      try { head = (await api.rest.git.getRef({ ...scope, ref: 'heads/' + branch(record), request })).data.object.sha; }
      catch (error) { if (!missing(error)) throw error; }
      if (head) {
        await validateHead(record, head, signal);
      } else {
        let exists = false;
        try { await api.rest.repos.getContent({ ...scope, path: correctionFile(record), ref: record.base_sha!, request }); exists = true; }
        catch (error) { if (!missing(error)) throw error; }
        if (exists) throw new ServiceError(409, 'CORRECTION_PATH_CONFLICT');
        const base = (await api.rest.git.getCommit({ ...scope, commit_sha: record.base_sha!, request })).data;
        const blob = (await api.rest.git.createBlob({ ...scope, content: correctionContent(record), encoding: 'utf-8', request })).data;
        const tree = (await api.rest.git.createTree({ ...scope, base_tree: base.tree.sha,
          tree: [{ path: correctionFile(record), mode: '100644', type: 'blob', sha: blob.sha }], request })).data;
        const commit = (await api.rest.git.createCommit({ ...scope, message: `docs: propose legal correction ${record.id}`, tree: tree.sha, parents: [record.base_sha!], request })).data;
        head = commit.sha;
        await validateHead(record, head, signal);
        await api.rest.git.createRef({ ...scope, ref: 'refs/heads/' + branch(record), sha: head, request });
      }
      const p = record.proposal;
      // The body contains only the exact reviewed public payload, never actor credentials or confirmation tokens.
      const body = `법령·해석 교정 자료 제안입니다. 사용자의 생성 동의를 전달받아 draft로 제출합니다.\n\n` +
        `작성 AI의 정정 제안이며 **별도 AI 검수는 미확인**, 사람 검수·머지 전입니다. 코드 자동 패치나 법적 정답 확정을 의미하지 않습니다.\n\n` +
        `제안 ID: ${record.id}\n기준 commit: ${record.base_sha}\n검토 대상 commit: ${head}\n\n` +
        '교정 내용은 변경 파일의 JSON에서 확인하세요. 출처·적용 시점·반박 타당성·개인정보 포함 여부를 검수하고, 필요한 수정이 있으면 새 교정 제안으로 제출하세요. 자동 머지는 하지 않습니다.\n\n' +
        '```json\n' + correctionContent(record).replaceAll('```', '\\u0060\\u0060\\u0060') + '```\n';
      const { data: pr } = await api.rest.pulls.create({ ...scope, head: branch(record), base: options.baseBranch, draft: true,
        title: `[법령 교정] ${p.title.replaceAll('@', '＠')}`, body, request });
      if (pr.head.sha !== head) throw new ServiceError(409, 'CORRECTION_PR_CHANGED');
      return { number: pr.number, url: pr.html_url, head_sha: head! };
    },
    async inspect(record, suppliedSignal) {
      const signal = suppliedSignal ?? AbortSignal.timeout(15000);
      const pr = await find(record, signal);
      if (!pr) {
        if (record.pr || record.target_repository !== target) return { state: 'missing' };
        let head: string | undefined;
        try { head = (await api.rest.git.getRef({ ...scope, ref: 'heads/' + branch(record), request: { signal } })).data.object.sha; }
        catch (error) { if (!missing(error)) throw error; }
        if (head) await validateHead(record, head, signal);
        return { state: 'retry_available' };
      }
      const identity = { number: pr.number, url: pr.html_url, head_sha: pr.head.sha };
      if (pr.merged) {
        try {
          if (await readContent(record, options.baseBranch, signal) !== correctionContent(record)) return { state: 'changed', pr: identity };
        } catch (error) { if (missing(error)) return { state: 'changed', pr: identity }; throw error; }
        return { state: 'merged', pr: identity };
      }
      return { state: pr.state === 'closed' ? 'closed' : 'pending_review', pr: identity };
    },
    async merged(records, signal, onVerified) {
      if (!records.length) return [];
      const request = { signal };
      const main = (await api.rest.git.getRef({ ...scope, ref: 'heads/' + options.baseBranch, request })).data.object.sha;
      const commit = (await api.rest.git.getCommit({ ...scope, commit_sha: main, request })).data;
      const tree = (await api.rest.git.getTree({ ...scope, tree_sha: commit.tree.sha, recursive: '1', request })).data;
      if (tree.truncated) throw new ServiceError(503, 'CORRECTION_TREE_INCOMPLETE');
      const files = new Map(tree.tree.map(entry => [entry.path, entry]));
      const found: string[] = [], pending: CorrectionRecord[] = [];
      for (const record of records) {
        const content = Buffer.from(correctionContent(record), 'utf8');
        const expected = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
        const entry = files.get(correctionFile(record));
        if (!record.pr || entry?.type !== 'blob' || entry.mode !== '100644' || entry.sha !== expected) continue;
        // Merge is an immutable event; main's exact file is rechecked on every refresh.
        const marker = record.merge_verified;
        if (marker?.proposal_hash !== record.proposal_hash || marker.head_sha !== record.pr.head_sha || marker.number !== record.pr.number || marker.target_repository !== target || marker.base_branch !== options.baseBranch) pending.push(record);
        else found.push(record.id);
      }
      for (const record of pending) {
        if (signal.aborted) break;
        const identity = record.pr!;
        try {
          const { data: pr } = await api.rest.pulls.get({ ...scope, pull_number: identity.number, request });
          if (!pr.merged || pr.base.ref !== options.baseBranch || pr.head.ref !== branch(record) || pr.head.repo?.full_name !== target || pr.head.sha !== identity.head_sha) continue;
          onVerified?.(record); // Persist each immutable event before attempting another remote request.
          found.push(record.id);
        } catch {
          if (signal.aborted) break;
          // This unverified record must not block rechecking already verified main files.
        }
      }
      return found;
    },
  };
}
export function configuredCorrectionService(env: NodeJS.ProcessEnv) {
  if (env.CORRECTION_PR_ENABLED !== '1') return undefined;
  try {
    if (!env.CORRECTION_STATE_DIR || !env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new ServiceError(503, 'CORRECTION_CONFIG_MISSING');
    return new CorrectionService({ directory: env.CORRECTION_STATE_DIR,
      repository: createCorrectionRepository({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, baseBranch: env.GITHUB_BASE_BRANCH || 'main' }),
      secrets: Object.entries(env).filter(([k]) => /KEY|TOKEN|SECRET|LAW_OC/.test(k)).map(([,v]) => v!).filter(Boolean) });
  } catch {
    console.error('CORRECTION_INITIALIZATION_UNAVAILABLE: law lookup remains enabled.');
    return undefined;
  }
}
