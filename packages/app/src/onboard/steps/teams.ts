// Onboarding step `teams`: main 22.2 step 1 and ADR 0005; may be blocked on the Teams upload policy.
//
// The Teams bot is registered by hand in the Teams Developer Portal: without an Azure subscription there
// is no API for it. The step explains that, opens the portal, and reads the bot's app id, tenant id and
// client secret (hidden). It checks all three by asking Microsoft for a Bot Connector token and a Graph
// token; a refusal asks again. The secret, the app id and the tenant id go to `.env` as the names `serve`
// reads (`TEAMS_APP_PASSWORD`, `TEAMS_APP_ID`, `TEAMS_TENANT_ID`).
//
// The team owner then signs in by device code (nothing is stored from that sign-in), and the step lists the
// owner's teams and channels and asks which channels are bug-shaped. It installs through
// `onboard/teams/install.ts`, which publishes the package, installs it, and reads the team's grants. It
// reports full mode, or reduced mode with the grant a team owner still has to approve and where.
//
// A tenant that forbids custom app upload (or install) is not a failure: the admin center steps are printed,
// the package is saved for the upload, the step is blocked on the admin, and the later steps run. Run the
// step again after the admin has acted and it checks the install again.
//
// A saved bot registration is re-checked on a rerun and kept only on a yes. Secrets go to `.env` only; the
// step's data holds the app id, tenant id, the teams with their modes, and the channels
// `{ id, name, teamId }`.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBotTokenSource, createGraphTokenSource, TeamsAuthError } from '../../adapters/teams/auth.ts';
import { createTeamsGraph, type GraphChannel, type GraphTeam, type TeamsGraph } from '../../adapters/teams/graph.ts';
import { SecretValue } from '../interview/io.ts';
import type { JsonObject } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { DeviceCodeError, installTeamsApp, signInByDeviceCode, TEAMS_APP_NAME, type TeamsInstallResult } from '../teams/install.ts';

export interface TeamsStepDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Microsoft's sign-in host; tests point it at a fake. */
  readonly loginHost?: string;
  /** Microsoft Graph's base address; tests point it at a fake. */
  readonly graphBaseUrl?: string;
  /** Pauses between device code checks. Default a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEVELOPER_PORTAL_URL = 'https://dev.teams.microsoft.com/bots';
export const ADMIN_CENTER_URL = 'https://admin.teams.microsoft.com';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_FILE = 'snapwing-teams-app.zip';

type Check = { status: 'ok' } | { status: 'rejected' } | { status: 'unreachable' };

type SavedChannel = { readonly id: string; readonly name: string; readonly teamId: string };

const toNames = (answer: string): string[] => [...new Set(answer.split(/[,;\n]+/).map((n) => n.trim().replace(/^#/, '')).filter((n) => n !== ''))];

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const teamName = (t: GraphTeam): string => t.displayName ?? t.id;
const channelName = (c: GraphChannel): string => c.displayName ?? c.id;

export function createTeamsStep(deps: TeamsStepDeps = {}): OnboardStep {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  /** Asks Microsoft for a Bot Connector token and a Graph token: both must come back for the bot to work. */
  async function checkRegistration(appId: string, tenantId: string, password: SecretValue): Promise<Check> {
    const credentials = {
      appId,
      password: password.reveal(),
      tenantId,
      fetch: doFetch,
      ...(deps.loginHost === undefined ? {} : { loginHost: deps.loginHost }),
    };
    try {
      await createBotTokenSource(credentials).token();
      await createGraphTokenSource(credentials).token();
      return { status: 'ok' };
    } catch (e) {
      return e instanceof TeamsAuthError && e.status >= 400 && e.status < 500 ? { status: 'rejected' } : { status: 'unreachable' };
    }
  }

  /** The app id, tenant id and client secret, asked until Microsoft gives a token for them. */
  async function askRegistration(ctx: StepContext): Promise<{ appId: string; tenantId: string; password: SecretValue }> {
    const { io } = ctx;
    io.say(
      `Snapwing needs a bot registered in the Teams Developer Portal. Microsoft has no API for that without an Azure subscription, so you make it by hand: open ${DEVELOPER_PORTAL_URL}, choose "New bot", name it ${TEAMS_APP_NAME}, and set its endpoint to your Snapwing public address followed by /teams/messages.`,
    );
    io.say(
      "Then open the bot, choose \"Client secrets\", add a secret, and copy it right away (Microsoft shows it once). The bot's page also shows its app (client) id, and your tenant id is on the Microsoft Entra overview page.",
    );
    await ctx.openUrl(DEVELOPER_PORTAL_URL);
    const appId = (
      await io.ask({
        id: 'app-id',
        text: "What is the bot's app (client) id?",
        why: 'It is a long id made of letters, digits and dashes. It is saved in your .env file as TEAMS_APP_ID.',
        validate: (answer) => (GUID.test(answer.trim()) ? undefined : "An app id looks like 11111111-2222-3333-4444-555555555555. Copy it from the bot's page."),
      })
    ).trim();
    const tenantId = (
      await io.ask({
        id: 'tenant-id',
        text: 'What is your tenant id?',
        why: 'New bot registrations belong to one Microsoft tenant, and Snapwing asks that tenant for its tokens. It is saved in your .env file as TEAMS_TENANT_ID.',
        validate: (answer) => (GUID.test(answer.trim()) ? undefined : 'A tenant id looks like 11111111-2222-3333-4444-555555555555. Copy it from the Microsoft Entra overview page.'),
      })
    ).trim();
    const password = await io.secret({
      id: 'client-secret',
      text: 'Paste the client secret.',
      why: 'The secret lets Snapwing sign in as the bot to post and to read. It will not show as you type, and it is stored only in your .env file.',
      validate: async (answer) => {
        const check = await checkRegistration(appId, tenantId, answer);
        if (check.status === 'ok') return undefined;
        return check.status === 'rejected'
          ? "Microsoft did not accept that secret for this app id and tenant id. Copy the secret's value (not its id) from the bot's \"Client secrets\" page and paste it again."
          : 'I could not reach Microsoft to check that secret. Check your connection and paste it again.';
      },
    });
    return { appId, tenantId, password };
  }

  /** The address Teams posts to, from the environment, else asked. */
  async function publicUrlFor(ctx: StepContext): Promise<{ url: string; teamsOnly: boolean }> {
    const own = (await ctx.readEnv('TEAMS_PUBLIC_URL'))?.reveal();
    const shared = (await ctx.readEnv('SNAPWING_PUBLIC_URL'))?.reveal();
    const known = own ?? shared;
    if (known !== undefined && /^https:\/\//.test(known)) return { url: known.replace(/\/+$/, ''), teamsOnly: false };
    const url = (
      await ctx.io.ask({
        id: 'public-url',
        text: 'What public https address does Teams reach Snapwing at?',
        why: 'Teams sends messages to this address followed by /teams/messages, so it has to be reachable from the internet over https. It is saved in your .env file as TEAMS_PUBLIC_URL.',
        validate: (answer) => (/^https:\/\/[^\s/]+/.test(answer.trim()) ? undefined : 'It has to start with https://, for example https://snapwing.example.com.'),
      })
    )
      .trim()
      .replace(/\/+$/, '');
    return { url, teamsOnly: shared === undefined || shared.replace(/\/+$/, '') !== url };
  }

  /** The team owner signs in by device code; a failure offers another try or a stop. */
  async function signIn(ctx: StepContext, appId: string, tenantId: string): Promise<SecretValue> {
    const { io } = ctx;
    for (;;) {
      try {
        return await signInByDeviceCode({
          tenantId,
          clientId: appId,
          fetch: doFetch,
          ...(deps.loginHost === undefined ? {} : { loginHost: deps.loginHost }),
          ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
          prompt: (p) => {
            io.say(`The team owner signs in now: open ${p.verificationUri} and enter the code ${p.userCode}. It works for ${Math.round(p.expiresIn / 60)} minutes.`);
            void ctx.openUrl(p.verificationUri);
          },
        });
      } catch (e) {
        if (!(e instanceof DeviceCodeError)) throw e;
        io.say(
          e.code === 'unauthorized_client' || e.code === 'invalid_client'
            ? 'Microsoft would not start the sign-in for this bot. In the Microsoft Entra admin center, open the bot\'s app registration, Authentication, and turn on "Allow public client flows".'
            : `The sign-in did not finish (${e.code}).`,
        );
        const next = await io.choose({
          id: 'sign-in-again',
          text: 'Try the sign-in again?',
          choices: [
            { id: 'again', label: 'Yes, show me a new code' },
            { id: 'stop', label: 'No, stop here and run onboarding again later' },
          ],
          default: 'again',
          why: 'The sign-in lets a team owner approve what Snapwing installs. Nothing from it is stored.',
        });
        if (next === 'stop') throw new Error('the Teams owner sign-in did not finish; run onboarding again', { cause: e });
      }
    }
  }

  /** Which teams to set up: the only one, else the ones named. */
  async function chooseTeams(ctx: StepContext, all: readonly GraphTeam[]): Promise<GraphTeam[]> {
    const { io } = ctx;
    const [only] = all;
    if (all.length === 1 && only !== undefined) {
      io.say(`The team is ${teamName(only)}.`);
      return [only];
    }
    io.say('These are the teams you belong to:');
    for (const t of all) io.say(`  ${teamName(t)}`);
    let chosen: GraphTeam[] = [];
    await io.ask({
      id: 'teams',
      text: 'Which of them should Snapwing join? Type their names, separated by commas.',
      why: 'Snapwing is installed in each team you name, and only there. You can add teams later by running onboarding again.',
      validate: (answer) => {
        const names = toNames(answer);
        if (names.length === 0) return 'Type at least one team name.';
        const unknown = names.filter((n) => !all.some((t) => sameName(teamName(t), n)));
        if (unknown.length > 0) return `I do not see ${unknown.join(', ')} in the list. Type the names as shown.`;
        chosen = [...new Set(names.flatMap((n) => all.filter((t) => sameName(teamName(t), n))))];
        return undefined;
      },
    });
    return chosen;
  }

  /** Which channels of a team are bug-shaped. */
  async function chooseChannels(ctx: StepContext, team: GraphTeam, channels: readonly GraphChannel[], questionId: string): Promise<SavedChannel[]> {
    const { io } = ctx;
    if (channels.length === 0) {
      io.say(`I do not see any channels in ${teamName(team)} yet.`);
      return [];
    }
    io.say(`These are the channels in ${teamName(team)}:`);
    for (const c of channels) io.say(`  ${channelName(c)}`);
    let chosen: GraphChannel[] = [];
    await io.ask({
      id: questionId,
      text: 'Which of them do people report bugs in? Type their names, separated by commas, or "none".',
      why: 'Snapwing watches each one you name for the bug reaction, and posts there. You can change this later.',
      validate: (answer) => {
        const names = toNames(answer);
        if (names.length === 0) return 'Type at least one channel name, or "none".';
        if (names.length === 1 && names[0]?.toLowerCase() === 'none') {
          chosen = [];
          return undefined;
        }
        const unknown = names.filter((n) => !channels.some((c) => sameName(channelName(c), n)));
        if (unknown.length > 0) return `I do not see ${unknown.map((n) => `"${n}"`).join(', ')} in the list. Type the names as shown.`;
        chosen = [...new Set(names.flatMap((n) => channels.filter((c) => sameName(channelName(c), n))))];
        return undefined;
      },
    });
    return chosen.map((c) => ({ id: c.id, name: channelName(c), teamId: team.id }));
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const saved = ctx.data('teams');
    if (saved === undefined) {
      io.say('Now Microsoft Teams, where bugs will be reported.');
      // Asked only before anything is saved: a registered (or half-registered) bot is re-checked below.
      const use = await io.choose({
        id: 'use',
        text: 'Does your team report bugs in Microsoft Teams?',
        choices: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No, leave Teams out' },
        ],
        default: 'yes',
        why: 'Snapwing needs at least one chat platform, Slack or Teams. Leaving Teams out skips this step; run `snapwing onboard --step teams` to add it later.',
      });
      if (use === 'no') {
        io.say('Leaving Teams out. Run `snapwing onboard --step teams` if your team starts using it.');
        return { status: 'skipped', reason: 'the installer does not use Teams' };
      }
    }

    // ---- a saved bot registration, re-checked ----------------------------------------------------
    let appId: string | undefined;
    let tenantId: string | undefined;
    const savedAppId = typeof saved?.['appId'] === 'string' && saved['appId'] !== '' ? saved['appId'] : undefined;
    const savedTenant = typeof saved?.['tenantId'] === 'string' && saved['tenantId'] !== '' ? saved['tenantId'] : undefined;
    const savedPassword = await ctx.readEnv('TEAMS_APP_PASSWORD');
    if (savedAppId !== undefined && savedTenant !== undefined && savedPassword !== undefined && saved?.['registered'] === true) {
      const check = await checkRegistration(savedAppId, savedTenant, savedPassword);
      if (check.status === 'ok') {
        const keep = await io.choose({
          id: 'keep',
          text: 'Teams: keep using the saved bot registration?',
          choices: [
            { id: 'keep', label: 'Yes, keep it' },
            { id: 'change', label: 'No, enter the bot again' },
          ],
          default: 'keep',
          why: 'The saved secret is in your .env file and Microsoft still accepts it. Entering the bot again asks for the ids and the secret; the saved ones stay until Microsoft accepts the new ones.',
        });
        if (keep === 'keep') {
          appId = savedAppId;
          tenantId = savedTenant;
        }
      } else if (check.status === 'rejected') {
        io.say("Microsoft no longer accepts the saved bot secret, so I need the bot's details again.");
      } else {
        const next = await io.choose({
          id: 'unreachable',
          text: 'I could not reach Microsoft to check the saved bot. Stop here and try again later, or enter the bot again?',
          choices: [
            { id: 'later', label: 'Stop here; I will run onboarding again later' },
            { id: 'change', label: 'Enter the bot again' },
          ],
          default: 'later',
          why: 'Microsoft did not answer (no connection, a firewall, or an outage), so the saved bot may well be fine.',
        });
        if (next === 'later') throw new Error('could not reach Microsoft to check the saved Teams bot; check the connection, then run onboarding again');
      }
    }
    if (appId === undefined || tenantId === undefined) {
      const entered = await askRegistration(ctx);
      appId = entered.appId;
      tenantId = entered.tenantId;
      await ctx.writeEnv({ TEAMS_APP_ID: appId, TEAMS_TENANT_ID: tenantId, TEAMS_APP_PASSWORD: entered.password });
      await ctx.progress({ appId, tenantId, registered: true });
      io.say('Microsoft accepted the bot.');
    }

    // ---- the address Teams posts to -----------------------------------------------------------------
    const publicUrl = await publicUrlFor(ctx);
    if (publicUrl.teamsOnly) await ctx.writeEnv({ TEAMS_PUBLIC_URL: publicUrl.url });

    // ---- the team owner, the teams, the channels ----------------------------------------------------
    io.say('A team owner has to approve the install, so they sign in next. If that is not you, they can do it with you on a call.');
    const ownerToken = ctx.redact(await signIn(ctx, appId, tenantId));
    const graph: TeamsGraph = createTeamsGraph({
      token: ownerToken.reveal(),
      fetch: doFetch,
      ...(deps.graphBaseUrl === undefined ? {} : { baseUrl: deps.graphBaseUrl }),
    });
    let teams: GraphTeam[];
    try {
      teams = await graph.teams({ joined: true });
    } catch (e) {
      throw new Error('could not list your teams after the sign-in; run onboarding again', { cause: e });
    }
    if (teams.length === 0) {
      io.say('The account that signed in is not in any team. Create the team where bugs will be reported, then run onboarding again.');
      return { status: 'blocked', on: 'a team owner', reason: 'the account that signed in belongs to no team yet; create the team, then run onboarding again', link: 'https://teams.microsoft.com' };
    }
    const chosenTeams = await chooseTeams(ctx, teams);

    const channels: SavedChannel[] = [];
    const picked: { team: GraphTeam; install: TeamsInstallResult }[] = [];
    for (const [i, team] of chosenTeams.entries()) {
      let list: GraphChannel[];
      try {
        list = await graph.channels(team.id);
      } catch (e) {
        throw new Error(`could not list the channels of ${teamName(team)}; run onboarding again`, { cause: e });
      }
      channels.push(...(await chooseChannels(ctx, team, list, chosenTeams.length === 1 ? 'channels' : `channels-${i + 1}`)));

      // ---- the install ---------------------------------------------------------------------------------
      io.say(`Installing ${TEAMS_APP_NAME} in ${teamName(team)}...`);
      const install = await installTeamsApp({ graph, appId, publicUrl: publicUrl.url, teamId: team.id });
      for (const w of install.warnings) io.say(`Heads up: ${w}. I am carrying on, but check that the old one is not still in use.`);
      picked.push({ team, install });
    }

    const data: JsonObject = {
      appId,
      tenantId,
      registered: true,
      teams: picked.map(({ team, install }) => ({ id: team.id, name: teamName(team), mode: install.mode })),
      teamId: picked[0]?.team.id ?? '',
      teamIds: picked.map(({ team }) => team.id),
      mode: picked.every(({ install }) => install.mode === 'full') ? 'full' : 'reduced',
      channels: channels.map((c) => ({ id: c.id, name: c.name, teamId: c.teamId })),
    };

    // ---- a tenant that forbids upload or install: the admin center steps, and the step is blocked ----
    const needAdmin = picked.filter((p) => p.install.adminSteps.length > 0);
    if (needAdmin.length > 0) {
      for (const { team, install } of needAdmin) {
        io.say(`Your Microsoft 365 settings do not let a person add ${TEAMS_APP_NAME} to ${teamName(team)} (custom app upload or install is turned off). A Teams admin can do it:`);
        install.adminSteps.forEach((step, n) => io.say(`  ${n + 1}. ${step}`));
        if (install.packageZip !== undefined) {
          const file = join(ctx.workdir, PACKAGE_FILE);
          await writeFile(file, install.packageZip);
          io.say(`The app package for that upload is saved at ${file}.`);
        }
      }
      io.say('I will carry on with the steps that do not need the bot; run onboarding again once the admin has added it.');
      return {
        status: 'blocked',
        on: 'a Teams admin',
        reason: 'custom app upload is turned off in this Microsoft 365 tenant; a Teams admin has to add the app, then run onboarding again',
        link: ADMIN_CENTER_URL,
        data,
      };
    }

    // ---- the mode ------------------------------------------------------------------------------------------
    for (const { team, install } of picked) {
      if (install.mode === 'full') {
        io.say(`${teamName(team)}: full mode. ${TEAMS_APP_NAME} can read the channels you chose.`);
      } else {
        const link = `https://teams.microsoft.com/l/app/${encodeURIComponent(install.teamsAppId ?? appId)}`;
        io.say(
          `${teamName(team)}: reduced mode. A team owner has to approve ${TEAMS_APP_NAME} reading channel messages, by adding it to the team from ${link}; until then it only sees messages sent to it directly.`,
        );
      }
    }
    return { status: 'done', data };
  }

  return { id: 'teams', title: 'Connect Microsoft Teams', needs: ['runtime'], run };
}

export const teamsStep: OnboardStep = createTeamsStep();
