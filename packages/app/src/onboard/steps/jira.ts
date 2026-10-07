// Onboarding step `jira`: main 22.2 step 2; runs without a chat bot token (ADR 0004).
//
// The account comes first. Snapwing works with Jira Cloud only, and the step says so before it asks
// anything. It asks for the site address (refused before any request unless it is
// https://<name>.atlassian.net), the account email, and an API token (hidden); checks them with
// `/myself`; and checks that the account is a Jira admin (`mypermissions`), since the setup creates
// fields and registers a webhook. Any refusal asks for all three again, with the site and the email
// prefilled. Only an accepted admin login is saved. A saved login (a resumed step, or `--step jira`)
// is checked the same way first: one Jira refuses, or that is not an admin, is asked for again, and
// one that works can be kept or swapped for another site or account. When the setup itself gets a 401
// or 403 the saved login is cleared, so the next run asks for it again.
//
// Then the step lists the projects and records the chosen ones, and runs the Jira bootstrap (main
// 14.4, `onboard/jira/bootstrap.ts`) inside the step: custom fields, screens, the status mapping, and
// the webhook when a public URL and a webhook secret exist. The installer never sees a field id, a
// webhook URL, or a transition name (main 22.3): this file says what happened in plain words and the
// bootstrap's own lines are not printed.
//
// A team-managed project cannot hold the custom fields, so one is explained in one sentence and
// another is asked for. A project missing a status category is named by category and the step
// continues; any other setup failure stops the step. Secrets go to `.env` only; the step's data holds
// the site, the email, and the project keys, never the token or the webhook secret.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createJiraClient, JiraAuthError } from '../../jira/client/index.ts';
import { CONFIG_FILE } from '../config-write.ts';
import { SecretValue } from '../interview/io.ts';
import type { JsonObject } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { runBootstrap } from '../jira/bootstrap.ts';
import { checkJiraAdmin, checkSiteAddress, CLOUD_ONLY, describeStatusProblems, listProjects, type SiteProject } from '../jira/site.ts';

const TEAM_MANAGED =
  'That one is a team-managed project, which cannot hold the extra fields Snapwing needs, so pick a company-managed one instead.';

const ADMIN_NEEDED =
  'Snapwing needs a Jira admin account: it adds its own fields to your projects and signs up for ticket updates, which Jira lets only admins do.';

const ASK_AGAIN = 'I will ask for the site, the email, and the token again; press Enter to keep the site or the email you gave.';

const TOKEN_LINK = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface JiraStepDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

type WebhookState = 'registered' | 'waiting' | 'failed';

/** A login Jira accepted, for an account that is a Jira admin. */
interface Login {
  readonly baseUrl: string;
  readonly email: string;
  readonly token: SecretValue;
  /** How Jira names the account. */
  readonly name: string;
}

type LoginCheck = { readonly status: 'ok'; readonly name: string } | { readonly status: 'rejected' | 'not-admin' | 'unreachable' };

function keysOf(answer: string): string[] {
  return [...new Set(answer.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter((k) => k !== ''))];
}

const hostOf = (baseUrl: string): string => new URL(baseUrl).host;

export function createJiraStep(deps: JiraStepDeps = {}): OnboardStep {
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };

  /** `/myself`, then the admin check. Never throws. */
  async function checkLogin(baseUrl: string, email: string, token: SecretValue): Promise<LoginCheck> {
    const apiToken = token.reveal();
    let name: string;
    try {
      const me = await createJiraClient({ baseUrl, email, apiToken, ...fetchOpt }).myself();
      name = me.displayName ?? email;
    } catch (e) {
      return { status: e instanceof JiraAuthError ? 'rejected' : 'unreachable' };
    }
    const admin = await checkJiraAdmin({ baseUrl, email, apiToken, ...fetchOpt });
    return admin === 'admin' ? { status: 'ok', name } : { status: admin };
  }

  /**
   * The saved login, when Jira still accepts it for an admin and the installer keeps it; undefined
   * when one must be asked for. Throws when the site cannot be reached and the installer stops there.
   */
  async function savedLogin(ctx: StepContext, site: string | undefined, email: string | undefined): Promise<Login | undefined> {
    const { io } = ctx;
    const token = await ctx.readEnv('JIRA_API_TOKEN');
    if (site === undefined || email === undefined || token === undefined) return undefined;
    const host = hostOf(site);
    const check = await checkLogin(site, email, token);
    switch (check.status) {
      case 'ok': {
        const keep = await io.choose({
          id: 'keep',
          text: `Jira: keep using ${host} as ${email}?`,
          choices: [
            { id: 'keep', label: 'Yes, keep this site and account' },
            { id: 'change', label: 'No, use another site or account' },
          ],
          default: 'keep',
          why: 'The saved API token is in your .env file and Jira still accepts it. Another site or account means the address, the email, and a token again; the saved ones stay until Jira accepts the new ones.',
        });
        return keep === 'keep' ? { baseUrl: site, email, token, name: check.name } : undefined;
      }
      case 'rejected':
        io.say(`Jira no longer accepts the saved login for ${host} (${email}), so I need it again.`);
        return undefined;
      case 'not-admin':
        io.say(`${email} is not a Jira admin on ${host}. ${ADMIN_NEEDED}`);
        return undefined;
      case 'unreachable': {
        const next = await io.choose({
          id: 'unreachable',
          text: `I could not reach ${host} to check the saved login. Stop here and try again later, or use another site or account?`,
          choices: [
            { id: 'later', label: 'Stop here; I will run onboarding again later' },
            { id: 'change', label: 'Use another site or account' },
          ],
          default: 'later',
          why: 'The site did not answer (no connection, a firewall, or Jira is down), so the saved login may well be fine.',
        });
        if (next === 'later') throw new Error(`could not reach ${host} to check the saved Jira login; check the connection, then run onboarding again`);
        return undefined;
      }
    }
  }

  /** Asks for the site, the email, and a token until Jira accepts them for an admin account. Saves nothing. */
  async function askLogin(ctx: StepContext, prefill: { readonly site?: string; readonly email?: string }): Promise<Login> {
    const { io } = ctx;
    let site = prefill.site;
    let email = prefill.email;
    let linkShown = false;
    for (;;) {
      let baseUrl = '';
      await io.ask({
        id: 'site',
        text: site === undefined ? 'Which Jira site? Paste its address (for example acme.atlassian.net).' : `Which Jira site? Press Enter for ${site}, or paste another address.`,
        ...(site === undefined ? {} : { default: site }),
        why: 'Snapwing talks to your site over its REST API at that address. Only Jira Cloud is supported, so it ends in .atlassian.net; the site address is enough, not a project link.',
        validate: (a) => {
          const checked = checkSiteAddress(a);
          if (!checked.ok) return checked.refusal;
          baseUrl = checked.baseUrl;
          return undefined;
        },
      });
      const given = await io.ask({
        id: 'email',
        text: email === undefined ? 'Which email do you sign in to Jira with?' : `Which email do you sign in to Jira with? Press Enter for ${email}, or type another.`,
        ...(email === undefined ? {} : { default: email }),
        why: 'Jira API tokens belong to an account; the email and token together are the login Snapwing uses.',
        validate: (a) => (EMAIL.test(a) ? undefined : 'That does not look like an email address.'),
      });
      if (!linkShown) {
        io.say(`Create an API token at ${TOKEN_LINK} and paste it below. It will not show as you type.`);
        await ctx.openUrl(TOKEN_LINK);
        linkShown = true;
      }
      const token = await io.secret({
        id: 'token',
        text: 'Paste the API token.',
        why: 'The token is stored only in your .env file, never in the onboarding state or any message.',
      });
      const check = await checkLogin(baseUrl, given, token);
      if (check.status === 'ok') return { baseUrl, email: given, token, name: check.name };
      io.say(
        check.status === 'rejected'
          ? 'Jira did not accept that email and token together on that site.'
          : check.status === 'not-admin'
            ? `That account signed in, but it is not a Jira admin. ${ADMIN_NEEDED} Use an admin account, or ask a Jira admin to make this one an admin.`
            : 'I could not reach that Jira site to check the login. Check the address and your connection.',
      );
      io.say(ASK_AGAIN);
      site = hostOf(baseUrl);
      email = given;
    }
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const saved = ctx.data('jira');
    // What an earlier attempt saved. A saved site that is not a Cloud address counts as never given.
    const savedSite = typeof saved?.['site'] === 'string' ? checkSiteAddress(saved['site']) : undefined;
    const site = savedSite?.ok === true ? savedSite.baseUrl : undefined;
    const savedEmail = typeof saved?.['email'] === 'string' ? saved['email'] : undefined;

    // ---- the account -------------------------------------------------------------------------
    let login = saved?.['credentials'] === 'ok' ? await savedLogin(ctx, site, savedEmail) : undefined;
    if (login === undefined) {
      if (saved === undefined) io.say('Now Jira, where the tickets will go.');
      io.say(`${CLOUD_ONLY} You need an API token for an account that is a Jira admin.`);
      login = await askLogin(ctx, {
        ...(site === undefined ? {} : { site: hostOf(site) }),
        ...(savedEmail === undefined ? {} : { email: savedEmail }),
      });
      await ctx.writeEnv({ JIRA_BASE_URL: login.baseUrl, JIRA_EMAIL: login.email, JIRA_API_TOKEN: login.token });
      await ctx.progress({ site: login.baseUrl, email: login.email, credentials: 'ok' });
    }
    const { baseUrl, email } = login;
    const apiToken = login.token.reveal();
    const client = createJiraClient({ baseUrl, email, apiToken, ...fetchOpt });
    io.say(`Signed in to Jira as ${login.name}.`);

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
    // JIRA_PROJECT_KEY records the first chosen project. Nothing in the service reads it: a bug goes
    // to the Jira project of the surface it resolves to. Every chosen key is kept in the step's data.
    await ctx.writeEnv({ JIRA_PROJECT_KEY: keys[0] ?? '' });

    // ---- the bootstrap, inside the step --------------------------------------------------------
    const configPath = join(ctx.workdir, CONFIG_FILE);
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
      if (report.teamManaged === true) {
        io.say(TEAM_MANAGED);
        throw new Error(`${key} is team-managed; run onboarding again and pick a company-managed project`);
      }
      if (report.authRefused === true) {
        // This login cannot do the setup, so the next run asks for one again.
        await ctx.progress({ credentials: null });
        io.say(`Jira refused part of the setup for ${key} with this login. ${ADMIN_NEEDED}`);
        throw new Error(`Jira refused the setup of ${key} for this login; run onboarding again and sign in with a Jira admin account`);
      }
      const failed = report.checks.filter((c) => !c.ok);
      // Only a workflow that lacks a status category is carried on from. Any other failure stops the
      // step, the workflow check's own included (Jira not answering, say).
      const onlyStatuses = failed.length > 0 && (report.statusProblems?.length ?? 0) > 0 && failed.every((c) => c.name === 'workflow');
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
      let secret = await ctx.readEnv('JIRA_WEBHOOK_SECRET');
      if (secret === undefined) {
        secret = new SecretValue(randomBytes(24).toString('hex'));
        await ctx.writeEnv({ JIRA_WEBHOOK_SECRET: secret });
      }
      let refused = false;
      webhook = 'registered';
      for (const key of keys) {
        const report = await runBootstrap({
          env: { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: apiToken, JIRA_PROJECT_KEY: key, SNAPWING_PUBLIC_URL: publicUrl, JIRA_WEBHOOK_SECRET: secret.reveal() },
          mode: 'webhook',
          ...fetchOpt,
        });
        if (!report.ok) webhook = 'failed';
        if (report.authRefused === true) refused = true;
      }
      if (refused) await ctx.progress({ credentials: null });
      io.say(
        webhook === 'registered'
          ? 'Jira will now tell Snapwing when a ticket changes.'
          : refused
            ? `Jira would not let this login sign Snapwing up for ticket updates. ${ADMIN_NEEDED} Run this step again with an admin account; everything else is done.`
            : 'I could not set up Jira updates just now. Run this step again later; everything else is done.',
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
