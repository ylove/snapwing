// Onboarding step `github`: the GitHub App, made through GitHub's manifest flow (main 22.2, 14.4); runs
// without a chat bot token (ADR 0004).
//
// The step asks who will own the App (a user or an organization) and what to call it (App names are
// global on GitHub, so the default carries the owner: "Snapwing (acme)"). It opens a local page that posts
// Snapwing's manifest to GitHub and catches the redirect on a local address, accepting it only with the
// random `state` it handed out. The credentials GitHub returns, a generated webhook secret, and the private
// key go to `.env` as secrets and are never printed. If the installer cancels, closes the tab, or the name
// is taken, no redirect comes: after a wait the step offers to try again (with the same name or another).
//
// It then prints the install link, waits for the installation, and lists the repositories the App can reach.
// An installation with no repository selected is not a failure: the step says where to add some and
// checks again, or stops blocked on that. Without a public https address the App gets the inactive
// placeholder webhook and Snapwing polls for pull-request changes instead.
//
// A saved App is re-checked with its own credentials on a rerun and kept on a yes. Secrets go to `.env`
// only; the step's data holds `{ appId, slug, name, owner, ownerType, installationId, repos }`.

import { randomBytes } from 'node:crypto';
import { SecretValue } from '../interview/io.ts';
import type { JsonObject } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { findInstallation, installationRepos, installUrlFor, readAppSlug, runManifestFlow, setWebhookConfig, type Conversion } from '../github/app.ts';
import type { GitHubDeps } from '../github/api.ts';
import { webBase } from '../github/api.ts';

export interface GitHubStepDeps {
  /** GitHub's REST base; tests point it at a fake. */
  readonly apiBase?: string;
  /** Where the manifest form posts and the install links live. */
  readonly webBase?: string;
  readonly fetch?: typeof fetch;
  /** How long to wait for GitHub to redirect back before offering to try again. Default 5 minutes. */
  readonly createWaitMs?: number;
  /** How long to wait for the installation before asking what to do. Default 10 minutes. */
  readonly installWaitMs?: number;
  /** Time between checks for the installation. Default 3 seconds. */
  readonly pollMs?: number;
  readonly manifestPath?: string;
}

/** GitHub's limit on an App's name. */
const MAX_NAME = 34;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createGitHubStep(deps: GitHubStepDeps = {}): OnboardStep {
  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const d: GitHubDeps = {
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      log: (line) => io.say(line),
      openUrl: (url) => void ctx.openUrl(url),
      now: ctx.now,
      ...(deps.apiBase === undefined ? {} : { apiBase: deps.apiBase }),
      ...(deps.webBase === undefined ? {} : { webBase: deps.webBase }),
    };
    const saved = ctx.data('github');
    const text = (key: string): string | undefined => (typeof saved?.[key] === 'string' && saved[key] !== '' ? saved[key] : undefined);
    if (saved === undefined) io.say('Now GitHub, where Snapwing opens its fixes as pull requests.');

    let appId: string | undefined;
    let slug: string | undefined;
    let pem: SecretValue | undefined;
    let name = text('name');
    let owner = text('owner');
    let ownerType = text('ownerType');

    // ---- a saved App, re-checked with its own credentials ----------------------------------------------
    // The id comes from the step's data, not `.env`: reading a key from `.env` makes its value a secret to the run.
    const savedId = text('appId');
    const savedKey = await ctx.readEnv('GITHUB_APP_PRIVATE_KEY');
    if (savedId !== undefined && savedKey !== undefined && owner !== undefined) {
      let found: string | undefined;
      let reachable = true;
      try {
        found = await readAppSlug(d, savedId, savedKey.reveal());
      } catch {
        reachable = false;
      }
      if (!reachable) {
        throw new Error('could not reach GitHub to check the saved App; check the connection, then run onboarding again');
      }
      if (found === undefined) {
        io.say('GitHub no longer accepts the saved App credentials, so I will create the App again.');
      } else {
        const keep = await io.choose({
          id: 'keep',
          text: `GitHub: keep using the saved App "${found}"?`,
          choices: [
            { id: 'keep', label: 'Yes, keep it' },
            { id: 'new', label: 'No, create a new one' },
          ],
          default: 'keep',
          why: 'The App and its key are in your .env file and GitHub still accepts them. Creating a new one leaves the old App on GitHub, which you can delete from its settings page.',
        });
        if (keep === 'keep') {
          appId = savedId;
          slug = found;
          pem = savedKey;
        }
      }
    }

    // ---- the App -------------------------------------------------------------------------------------------
    if (appId === undefined || slug === undefined || pem === undefined) {
      {
        io.say('GitHub apps belong to a person or an organization. Whoever owns it can install it and see its settings.');
        ownerType = await io.choose({
          id: 'owner-type',
          text: 'Who will own the GitHub App?',
          choices: [
            { id: 'user', label: 'My own GitHub account' },
            { id: 'org', label: 'A GitHub organization' },
          ],
          default: 'user',
          why: 'The App is created under this owner and can be installed on its repositories. An organization lets teammates manage it; a personal account is simplest for a trial.',
        });
        owner = await io.ask({
          id: 'owner',
          text: ownerType === 'org' ? "What is the organization's name on GitHub?" : 'What is your GitHub username?',
          validate: (answer) => (LOGIN.test(answer.trim()) ? undefined : 'GitHub names use letters, numbers, and single dashes. Type it as it appears in your GitHub address.'),
        });
        owner = owner.trim();
      }
      const ask = async (): Promise<string> =>
        (
          await io.ask({
            id: 'name',
            text: 'What should the GitHub App be called?',
            default: `Snapwing (${owner ?? ''})`,
            why: 'GitHub App names are unique across all of GitHub, so a name someone already took is refused. Press Enter for the suggestion.',
            validate: (answer) => (answer.trim().length > MAX_NAME ? `GitHub limits an App name to ${MAX_NAME} characters. Try a shorter one.` : undefined),
          })
        ).trim();
      name = await ask();

      // Only an https address reaches Snapwing from GitHub. Without one the runtime step leaves
      // http://localhost:<port>, which is no public address: the App then gets the inactive webhook.
      const given = ((await ctx.readEnv('SNAPWING_PUBLIC_URL'))?.reveal() ?? '').trim().replace(/\/+$/, '');
      const publicUrl = /^https:\/\//.test(given) ? given : '';
      if (publicUrl === '') {
        io.say('Snapwing has no public address yet, so the App is made with its webhook switched off, and Snapwing checks GitHub on a timer instead. Set a public address later and run onboarding again to switch the webhook on.');
      }

      for (;;) {
        let created: Conversion | undefined;
        let generated = '';
        try {
          created = await runManifestFlow(d, {
            publicUrl,
            name,
            ...(ownerType === 'org' ? { org: owner } : {}),
            owner,
            timeoutMs: deps.createWaitMs ?? 5 * 60 * 1000,
            ...(deps.manifestPath === undefined ? {} : { manifestPath: deps.manifestPath }),
            onConverted: async (c) => {
              generated = c.webhookSecret ?? randomBytes(32).toString('hex');
              await ctx.writeEnv({
                GITHUB_APP_ID: c.id,
                GITHUB_APP_SLUG: c.slug,
                GITHUB_APP_CLIENT_ID: c.clientId,
                GITHUB_APP_CLIENT_SECRET: new SecretValue(c.clientSecret),
                GITHUB_WEBHOOK_SECRET: new SecretValue(generated),
                GITHUB_APP_PRIVATE_KEY: new SecretValue(c.pem),
              });
            },
          });
        } catch (e) {
          const timedOut = e instanceof Error && e.message.startsWith('timed out');
          io.say(
            timedOut
              ? 'GitHub did not send you back. If you cancelled, or GitHub said the name is taken, that is fine.'
              : `GitHub did not finish creating the App (${e instanceof Error ? e.message : 'no answer'}).`,
          );
          const next = await io.choose({
            id: 'retry',
            text: 'Try creating the App again?',
            choices: [
              { id: 'retry', label: 'Yes, try again' },
              { id: 'rename', label: 'Yes, with a different name' },
              { id: 'stop', label: 'No, stop here and run onboarding again later' },
            ],
            default: 'retry',
            why: 'Nothing is kept from the attempt that did not finish, so trying again starts clean.',
          });
          if (next === 'stop') {
            return { status: 'blocked', on: 'you creating the GitHub App', reason: 'the GitHub App was not created; run onboarding again when you are ready to create it' };
          }
          if (next === 'rename') name = await ask();
          continue;
        }
        appId = created.id;
        slug = created.slug;
        pem = new SecretValue(created.pem);
        if (publicUrl !== '' && created.webhookSecret === null) {
          const ok = await setWebhookConfig(d, appId, created.pem, `${publicUrl}/webhooks/github`, generated).catch(() => false);
          if (!ok) io.say(`GitHub would not take the webhook secret. Open the App's settings at ${settingsUrl(d, ownerType, owner, slug)} and set a webhook secret there, then copy it into GITHUB_WEBHOOK_SECRET in your .env file.`);
        }
        break;
      }
      await ctx.progress({ appId, slug, name: name ?? '', owner: owner ?? '', ownerType: ownerType ?? 'user' });
      io.say(`The GitHub App "${name ?? slug}" is created. Its keys are saved in your .env file.`);
    } else {
      io.say(`The GitHub App "${slug}" is already created; I will pick up at the install.`);
    }

    // ---- the install ---------------------------------------------------------------------------------------
    const ownerLogin = owner ?? '';
    const installUrl = installUrlFor(d, slug);
    io.say(`Now install the App on the repositories Snapwing should be able to fix. Choose "Only select repositories" and pick them: ${installUrl}`);
    await ctx.openUrl(installUrl);
    let installationId = await findInstallation(d, appId, pem.reveal(), ownerLogin);
    const pollMs = deps.pollMs ?? 3000;
    for (let waited = 0; installationId === undefined; ) {
      if (waited === 0) io.say('Waiting for the install...');
      if (waited >= (deps.installWaitMs ?? 10 * 60 * 1000)) {
        const next = await io.choose({
          id: 'install-wait',
          text: `I do not see the App installed on ${ownerLogin} yet. Keep waiting?`,
          choices: [
            { id: 'wait', label: 'Yes, keep waiting' },
            { id: 'stop', label: 'No, stop here and run onboarding again after installing' },
          ],
          default: 'wait',
          why: `Open ${installUrl} and finish the install on the ${ownerType === 'org' ? 'organization' : 'account'} ${ownerLogin}; the App must be installed there for Snapwing to find it.`,
        });
        if (next === 'stop') {
          return {
            status: 'blocked',
            on: 'you installing the GitHub App',
            reason: 'the App is created but not installed; install it, then run onboarding again',
            link: installUrl,
            data: appData(appId, slug, name, owner, ownerType, undefined, []),
          };
        }
        waited = 0;
      }
      await sleep(pollMs);
      waited += Math.max(pollMs, 1);
      installationId = await findInstallation(d, appId, pem.reveal(), ownerLogin);
    }
    await ctx.writeEnv({ GITHUB_INSTALLATION_ID: installationId });
    await ctx.progress({ installationId });

    // ---- the repositories ------------------------------------------------------------------------------------
    let repos = await installationRepos(d, appId, pem.reveal(), installationId);
    while (repos.length === 0) {
      const settings = installationSettingsUrl(d, ownerType, ownerLogin, installationId);
      io.say(`The App is installed, but no repository is selected, so it can fix nothing yet. Add at least one under "Repository access": ${settings}`);
      const next = await io.choose({
        id: 'repos',
        text: 'Have you added a repository?',
        choices: [
          { id: 'check', label: 'Yes, check now' },
          { id: 'later', label: 'Not yet; I will do it later' },
        ],
        default: 'check',
        why: 'I list the repositories the App can reach. Snapwing opens its fixes only in those.',
      });
      if (next === 'later') {
        return {
          status: 'blocked',
          on: 'you choosing the repositories for the GitHub App',
          reason: 'the App is installed on no repository; add one, then run onboarding again',
          link: settings,
          data: appData(appId, slug, name, owner, ownerType, installationId, []),
        };
      }
      repos = await installationRepos(d, appId, pem.reveal(), installationId);
    }
    io.say(`The App can fix ${repos.length === 1 ? 'this repository' : 'these repositories'}:`);
    for (const r of repos) io.say(`  ${r}`);
    return { status: 'done', data: appData(appId, slug, name, owner, ownerType, installationId, repos) };
  }

  return { id: 'github', title: 'Connect GitHub', needs: ['runtime'], run };
}

function appData(appId: string, slug: string, name: string | undefined, owner: string | undefined, ownerType: string | undefined, installationId: string | undefined, repos: readonly string[]): JsonObject {
  return { appId, slug, name: name ?? slug, owner: owner ?? '', ownerType: ownerType ?? 'user', ...(installationId === undefined ? {} : { installationId }), repos: [...repos] };
}

function settingsUrl(d: GitHubDeps, ownerType: string | undefined, owner: string | undefined, slug: string): string {
  return ownerType === 'org' && owner !== undefined ? `${webBase(d)}/organizations/${encodeURIComponent(owner)}/settings/apps/${slug}` : `${webBase(d)}/settings/apps/${slug}`;
}

function installationSettingsUrl(d: GitHubDeps, ownerType: string | undefined, owner: string, installationId: string): string {
  return ownerType === 'org' ? `${webBase(d)}/organizations/${encodeURIComponent(owner)}/settings/installations/${installationId}` : `${webBase(d)}/settings/installations/${installationId}`;
}

export const githubStep: OnboardStep = createGitHubStep();
