// Onboarding step `jira`: main 22.2 step 2; runs without a chat bot token (ADR 0004).
//
// Asks for the site address, the account email, and an API token (hidden); validates them with
// `/myself`; lists the projects and records the chosen ones; then runs the Jira bootstrap (main 14.4,
// `onboard/jira/bootstrap.ts`) inside the step: custom fields, screens, the status mapping, and the
// webhook when a public URL and a webhook secret exist. The installer never sees a field id, a
// webhook URL, or a transition name (main 22.3): this file says what happened in plain words and
// the bootstrap's own lines are not printed.
//
// A team-managed project cannot hold the custom fields, so one is explained in one sentence and
// another is asked for. A project missing a status category is named by category and the step
// continues. Secrets go to `.env` only; the step's data holds the site, the email, and the project
// keys, never the token or the webhook secret.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createJiraClient, JiraAuthError } from '../../jira/client/index.ts';
import type { JsonObject } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { runBootstrap } from '../jira/bootstrap.ts';
import { describeStatusProblems, listProjects, normalizeSiteAddress, type SiteProject } from '../jira/site.ts';

const TEAM_MANAGED =
  'That one is a team-managed project, which cannot hold the extra fields Snapwing needs, so pick a company-managed one instead.';

export interface JiraStepDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

type WebhookState = 'registered' | 'waiting' | 'failed';

function keysOf(answer: string): string[] {
  return [...new Set(answer.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter((k) => k !== ''))];
}

export function createJiraStep(deps: JiraStepDeps = {}): OnboardStep {
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const saved = ctx.data('jira');
    const savedToken = await ctx.readEnv('JIRA_API_TOKEN');

    // ---- the account -------------------------------------------------------------------------
    let baseUrl: string;
    let email: string;
    let token = savedToken;
    if (saved?.['credentials'] === 'ok' && typeof saved['site'] === 'string' && typeof saved['email'] === 'string' && token !== undefined) {
      baseUrl = saved['site'];
      email = saved['email'];
      io.say(`Jira: picking up where we left off with ${baseUrl}.`);
    } else {
      io.say('Now Jira, where the tickets will go. You need an API token for an account that is a Jira site admin.');
      let site = '';
      await io.ask({
        id: 'site',
        text: 'Which Jira site? Paste its address (for example acme.atlassian.net).',
        why: 'Snapwing talks to your site over its REST API at that address. Only the site address is needed, not a project link.',
        validate: (a) => {
          site = normalizeSiteAddress(a) ?? '';
          return site === '' ? 'That does not look like a Jira address. Paste the address you open Jira at, such as acme.atlassian.net.' : undefined;
        },
      });
      baseUrl = site;
      email = await io.ask({
        id: 'email',
        text: 'Which email do you sign in to Jira with?',
        why: 'Jira API tokens belong to an account; the email and token together are the login Snapwing uses.',
        validate: (a) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? undefined : 'That does not look like an email address.'),
      });
      const link = 'https://id.atlassian.com/manage-profile/security/api-tokens';
      io.say(`Create an API token at ${link} and paste it below. It will not show as you type.`);
      await ctx.openUrl(link);
      token = await io.secret({
        id: 'token',
        text: 'Paste the API token.',
        why: 'The token is stored only in your .env file, never in the onboarding state or any message.',
        validate: async (candidate) => {
          try {
            await createJiraClient({ baseUrl, email, apiToken: candidate.reveal(), ...fetchOpt }).myself();
            return undefined;
          } catch (e) {
            if (e instanceof JiraAuthError) return 'Jira did not accept that email and token together. Check the email you gave, then paste the token again.';
            return 'I could not reach that Jira site to check the token. Check the address and your connection, then paste the token again.';
          }
        },
      });
      await ctx.writeEnv({ JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: token });
      await ctx.progress({ site: baseUrl, email, credentials: 'ok' });
    }
    if (token === undefined) throw new Error('the Jira token is missing');
    const apiToken = token.reveal();
    const client = createJiraClient({ baseUrl, email, apiToken, ...fetchOpt });
    const me = await client.myself();
    io.say(`Signed in to Jira as ${me.displayName ?? email}.`);

    // ---- the projects ------------------------------------------------------------------------
    const projects = await listProjects({ baseUrl, email, apiToken, ...fetchOpt });
    const usable = projects.filter((p) => !p.teamManaged);
    if (projects.length === 0) {
      return { status: 'blocked', on: 'a Jira site admin', reason: 'this account can see no Jira projects; add it to one, or create a company-managed project, then run onboarding again' };
    }
    if (usable.length === 0) {
      io.say(TEAM_MANAGED);
      return { status: 'blocked', on: 'a Jira site admin', reason: 'every project on the site is team-managed; create a company-managed project, then run onboarding again' };
    }
    io.say('These are the projects I can see:');
    for (const p of projects) io.say(`  ${p.key}  ${p.name}`);

    const chosen: SiteProject[] = [];
    while (chosen.length === 0) {
      const found: SiteProject[] = [];
      await io.ask({
        id: 'projects',
        text: 'Which projects should bugs go to? Type their keys, separated by commas.',
        why: 'The key is the short code in front of every ticket number, such as ABC in ABC-12. Each project gets its own setup; you can change this later.',
        validate: (a) => {
          found.length = 0;
          const keys = keysOf(a);
          if (keys.length === 0) return 'Type at least one project key.';
          const unknown = keys.filter((k) => !projects.some((p) => p.key.toUpperCase() === k));
          if (unknown.length > 0) return `I do not see ${unknown.join(', ')} in the list. Type the keys as shown.`;
          for (const k of keys) {
            const p = projects.find((q) => q.key.toUpperCase() === k);
            if (p !== undefined) found.push(p);
          }
          return undefined;
        },
      });
      for (const p of found) {
        // The list's style is a hint; the project itself is the authority.
        const project = p.teamManaged ? undefined : await client.getProject(p.key);
        const teamManaged = project === undefined || project.style === 'next-gen' || project.simplified === true;
        if (teamManaged) io.say(TEAM_MANAGED);
        else chosen.push(p);
      }
    }
    const keys = chosen.map((p) => p.key);
    await ctx.progress({ projects: keys });
    // The service reads one project key from the environment; the others are in the step's data.
    await ctx.writeEnv({ JIRA_PROJECT_KEY: keys[0] ?? '' });

    // ---- the bootstrap, inside the step --------------------------------------------------------
    const configPath = join(ctx.workdir, 'snapwing.config.xml');
    const statusNotes: string[] = [];
    for (const key of keys) {
      io.say(`Setting up Jira for ${key}...`);
      const report = await runBootstrap({
        env: { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: apiToken, JIRA_PROJECT_KEY: key },
        mode: 'fields',
        configPath,
        writeEnv: (entries) => ctx.writeEnv(entries),
        ...fetchOpt,
      });
      const failed = report.checks.filter((c) => !c.ok);
      const onlyStatuses = failed.length > 0 && failed.every((c) => c.name === 'workflow');
      if (report.teamManaged === true) {
        io.say(TEAM_MANAGED);
        throw new Error(`${key} is team-managed; run onboarding again and pick a company-managed project`);
      }
      if (failed.length > 0 && !onlyStatuses) {
        const why = failed[0]?.message ?? 'something went wrong';
        throw new Error(`could not set up Jira for ${key}: ${why}`);
      }
      if (onlyStatuses) {
        const missing = describeStatusProblems(report.statusProblems ?? []);
        io.say(`${key} has no status in ${missing}, so Snapwing cannot move its tickets to that stage. Add one in the project's workflow settings when you can; I am carrying on.`);
        statusNotes.push(`${key}: no status in ${missing}`);
      } else {
        io.say(`${key} is ready.`);
      }
    }

    // ---- the webhook -----------------------------------------------------------------------------
    let webhook: WebhookState = 'waiting';
    const publicUrl = (await ctx.readEnv('SNAPWING_PUBLIC_URL'))?.reveal();
    if (publicUrl === undefined || !/^https:\/\//.test(publicUrl)) {
      io.say('Snapwing has no public https address yet, so Jira cannot send it updates. Run this step again once it has one; nothing else is lost.');
    } else {
      let secret = (await ctx.readEnv('JIRA_WEBHOOK_SECRET'))?.reveal();
      if (secret === undefined) {
        secret = randomBytes(24).toString('hex');
        await ctx.writeEnv({ JIRA_WEBHOOK_SECRET: secret });
      }
      webhook = 'registered';
      for (const key of keys) {
        const report = await runBootstrap({
          env: { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: apiToken, JIRA_PROJECT_KEY: key, SNAPWING_PUBLIC_URL: publicUrl, JIRA_WEBHOOK_SECRET: secret },
          mode: 'webhook',
          ...fetchOpt,
        });
        if (!report.ok) webhook = 'failed';
      }
      io.say(
        webhook === 'registered'
          ? 'Jira will now tell Snapwing when a ticket changes.'
          : 'I could not set up Jira updates (the account probably is not a site admin). Fix that and run this step again; everything else is done.',
      );
    }

    const data: JsonObject = {
      site: baseUrl,
      email,
      projects: keys,
      webhook,
      ...(statusNotes.length > 0 ? { statusNotes } : {}),
    };
    return { status: 'done', data };
  }

  return { id: 'jira', number: 2, title: 'Connect Jira', needs: ['runtime'], run };
}

export const jiraStep: OnboardStep = createJiraStep();
