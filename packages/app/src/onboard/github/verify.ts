// `github:bootstrap verify` (main 14.4): finds the App's installation, records GITHUB_INSTALLATION_ID and
// GITHUB_APP_SLUG, and checks the installation and the fixture repository's branch protection.

import { signAppJwt } from '../../github/auth.ts';
import { call, DEFAULT_FIXTURE_REPO, ENV_FILE, envSecrets, ghToken, isRecord, must, REQUIRED_CHECK, splitRepo, str, updateEnvFile, type BootstrapDeps } from './api.ts';

export interface VerifyOptions {
  repo?: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  installationId: string | null;
  checks: VerifyCheck[];
}

export async function runVerify(d: BootstrapDeps, options: VerifyOptions = {}): Promise<VerifyResult> {
  const repo = options.repo ?? DEFAULT_FIXTURE_REPO;
  const { owner } = splitRepo(repo);
  d.log(`verify needs: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in ${ENV_FILE} (from \`app\`), the App installed on ${repo}, and \`gh\` logged in.`);
  const secrets = envSecrets(d);
  const appId = (await secrets.get('GITHUB_APP_ID')).trim();
  const pem = await secrets.get('GITHUB_APP_PRIVATE_KEY');
  const jwt = signAppJwt(appId, pem, d.now());

  const checks: VerifyCheck[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    d.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  };

  // The slug names the App's bot login (`<slug>[bot]`) for the GitHub webhook route; `app` writes it too, this picks it up on a re-run.
  const appBody = (await must(d, jwt, 'GET', '/app')).body;
  const slug = isRecord(appBody) ? str(appBody['slug'], 'slug') : str(undefined, 'slug');
  await updateEnvFile(d, { GITHUB_APP_SLUG: slug });
  record('app', true, `read App "${slug}"; wrote GITHUB_APP_SLUG to ${ENV_FILE}`);

  const listed = await must(d, jwt, 'GET', '/app/installations?per_page=100');
  const installs = Array.isArray(listed.body) ? listed.body.filter(isRecord) : [];
  const mine = installs.filter((i) => isRecord(i['account']) && String(i['account']['login']).toLowerCase() === owner.toLowerCase());
  const chosen = mine[0];
  const rawId = chosen?.['id'];
  if (rawId === undefined || (typeof rawId !== 'number' && typeof rawId !== 'string')) {
    record('installation', false, `the App is not installed on ${owner}; open the install link printed by \`app\``);
    return { ok: false, installationId: null, checks };
  }
  const installationId = String(rawId);
  await updateEnvFile(d, { GITHUB_INSTALLATION_ID: installationId });
  record('installation', true, `found installation ${installationId} on ${owner}; wrote GITHUB_INSTALLATION_ID to ${ENV_FILE}`);

  const tokenBody = (await must(d, jwt, 'POST', `/app/installations/${installationId}/access_tokens`, {})).body;
  const installToken = isRecord(tokenBody) ? str(tokenBody['token'], 'installation token') : str(undefined, 'installation token');
  const repos = (await must(d, installToken, 'GET', '/installation/repositories?per_page=100')).body;
  const names = isRecord(repos) && Array.isArray(repos['repositories']) ? repos['repositories'].filter(isRecord).map((r) => String(r['full_name']).toLowerCase()) : [];
  record('repository access', names.includes(repo.toLowerCase()), names.includes(repo.toLowerCase()) ? `installation covers ${repo}` : `installation does not cover ${repo}`);

  const gh = await ghToken(d);
  const owned = await call(d, gh, 'GET', `/repos/${repo}`);
  const branch = isRecord(owned.body) && typeof owned.body['default_branch'] === 'string' ? owned.body['default_branch'] : 'main';
  const prot = await call(d, gh, 'GET', `/repos/${repo}/branches/${branch}/protection`);
  if (prot.status === 404 || !isRecord(prot.body)) {
    record('branch protection', false, `${branch} has no protection rule; run \`fixture\``);
  } else {
    const rsc = prot.body['required_status_checks'];
    const contexts = isRecord(rsc) && Array.isArray(rsc['checks']) ? rsc['checks'].filter(isRecord).map((c) => c['context']) : [];
    const legacy = isRecord(rsc) && Array.isArray(rsc['contexts']) ? rsc['contexts'] : [];
    const prr = prot.body['required_pull_request_reviews'];
    const approvals = isRecord(prr) && typeof prr['required_approving_review_count'] === 'number' ? prr['required_approving_review_count'] : 0;
    const hasCheck = contexts.includes(REQUIRED_CHECK) || legacy.includes(REQUIRED_CHECK);
    record('branch protection', hasCheck && approvals >= 1, `${branch}: required check ${REQUIRED_CHECK} ${hasCheck ? 'present' : 'missing'}, ${approvals} approval(s) required`);
  }
  const ok = checks.every((c) => c.ok);
  if (ok) d.log('Next: `pnpm github:bootstrap secrets`.');
  return { ok, installationId, checks };
}
