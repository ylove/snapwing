// Onboarding step `slack`: main 22.2 step 1 (the chat platform); may be blocked on a Slack admin
// approving the install, and the steps after it carry on without the bot token.
//
// The step creates the Snapwing app in the installer's workspace from `manifests/slack/manifest.yaml`.
// It opens Slack's configuration token page and reads the pasted token (hidden; these expire after
// 12 hours, so an expired one is asked for again), checks the manifest with it, and creates the app.
// It then opens the install link and takes the bot token from the OAuth redirect when Snapwing has a
// public https address to catch it on, else by paste. Slack has no API for the app-level token Socket
// Mode needs, so that one is always pasted. Each token is checked with one cheap call and a refusal
// asks again; a saved bot token is re-checked on a resume and kept only on a yes.
//
// A workspace that needs an admin to approve installs is not a failure: the "Request to install"
// link is printed, the step is blocked on the admin, and the later steps that do not need the bot
// token run. Run the step again after the approval and it picks up at the install.
//
// With the bot token the step warns (never blocks) when another bot named Snapwing is in the
// workspace, lists the channels, asks which are bug-shaped and, separately, whether bugs are also
// reported in private channels, joins the public ones, and asks to be invited to the private ones.
// Secrets go to `.env` only; the step's data holds the app id, the workspace, and the channels.

import { DEFAULT_PORT } from '../../server/serve.ts';
import { APP_NAME, duplicateBotWarning, findOtherBots, type Manifest } from '../slack/bootstrap.ts';
import {
  authorizeUrl,
  botScopesOf,
  checkAppToken,
  checkBotToken,
  CONFIG_TOKEN_PAGE,
  createApp,
  DEFAULT_API_BASE,
  exchangeCode,
  installPageUrl,
  joinChannel,
  listChannels,
  listenForRedirect,
  manifestForCreate,
  OAUTH_CALLBACK_PATH,
  SlackCallError,
  validateManifest,
  type BotIdentity,
  type CreatedApp,
  type RedirectListener,
  type SlackChannel,
} from '../slack/install.ts';
import { randomBytes } from 'node:crypto';
import { SecretValue } from '../interview/io.ts';
import type { JsonObject } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';

export interface SlackStepDeps {
  /** Slack's Web API base; tests point it at a fake. */
  readonly apiBase?: string;
  /** Starts the catch for the OAuth redirect; undefined means the port could not be used. */
  readonly listen?: (port: number, state: string) => Promise<RedirectListener | undefined>;
  /** How long to wait for the redirect before asking for the token by paste. */
  readonly redirectWaitMs?: number;
  readonly manifestPath?: string | URL;
}

const APP_TOKEN_PAGE = (appId: string): string => `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;

const NO_APP_TOKEN_API = 'Slack has no API for the app-level token, so you create it by hand: on the Basic Information page, under App-Level Tokens, make one with the connections:write scope.';

const toNames = (answer: string): string[] => [...new Set(answer.split(/[\s,;]+/).map((n) => n.trim().replace(/^#/, '').toLowerCase()).filter((n) => n !== ''))];

type SavedChannel = { readonly id: string; readonly name: string; readonly private: boolean };

export function createSlackStep(deps: SlackStepDeps = {}): OnboardStep {
  const base = (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const listen = deps.listen ?? listenForRedirect;

  /** The configuration token, asked until Slack accepts it for the manifest; the app is created with it. */
  async function createFromManifest(ctx: StepContext, manifest: Manifest): Promise<CreatedApp> {
    const { io } = ctx;
    io.say('First, Snapwing needs to create its Slack app in your workspace.');
    io.say(`Open ${CONFIG_TOKEN_PAGE}, scroll to "Your App Configuration Tokens", generate one for your workspace, and paste the access token below. It will not show as you type, and it expires after 12 hours.`);
    await ctx.openUrl(CONFIG_TOKEN_PAGE);
    const token = await io.secret({
      id: 'config-token',
      text: 'Paste the app configuration token.',
      why: 'Slack lets only a configuration token create an app from a manifest. It is used for this and then dropped: it is not saved anywhere.',
      validate: async (answer) => {
        const check = await validateManifest(base, answer, manifest);
        if (check.status === 'ok') return undefined;
        if (check.status === 'token') return 'Slack did not accept that token. Configuration tokens expire after 12 hours; generate a fresh one on the same page and paste it.';
        if (check.status === 'unreachable') return 'I could not reach Slack to check that token. Check your connection and paste it again.';
        return `Slack did not accept Snapwing's app manifest: ${check.detail}`;
      },
    });
    try {
      return await createApp(base, token, manifest);
    } catch (e) {
      const why = e instanceof SlackCallError ? e.code : 'no answer';
      throw new Error(`could not create the Slack app (${why}); run onboarding again`, { cause: e });
    }
  }

  /** Asks for the bot token by paste until Slack accepts it. */
  async function pasteBotToken(ctx: StepContext, appId: string): Promise<{ token: SecretValue; bot: BotIdentity }> {
    ctx.io.say(`In the Slack app's "OAuth & Permissions" page (${installPageUrl(appId)}), copy the "Bot User OAuth Token", which starts with xoxb-.`);
    let bot: BotIdentity | undefined;
    const token = await ctx.io.secret({
      id: 'bot-token',
      text: 'Paste the bot token.',
      why: 'The bot token lets Snapwing read the channels it is in and post in them. It is stored only in your .env file.',
      validate: async (answer) => {
        const value = answer.reveal();
        if (!value.startsWith('xoxb-')) return 'A bot token starts with xoxb-. Copy the "Bot User OAuth Token", not the app or configuration token.';
        const check = await checkBotToken(base, answer);
        if (check.status === 'ok') {
          bot = check.value;
          return undefined;
        }
        return check.status === 'rejected' ? 'Slack did not accept that token. Copy it again from the page.' : 'I could not reach Slack to check that token. Check your connection and paste it again.';
      },
    });
    if (bot === undefined) throw new Error('the Slack bot token was not checked');
    return { token, bot };
  }

  /** The install: the link, then the bot token from the redirect or by paste, or a block for an admin. */
  async function install(
    ctx: StepContext,
    app: { appId: string; clientId?: string; clientSecret?: string },
    redirect: { uri: string; state: string; listener: RedirectListener } | undefined,
    scopes: readonly string[],
  ): Promise<{ token: SecretValue; bot: BotIdentity } | { blocked: StepOutcome }> {
    const { io } = ctx;
    const canRedirect = redirect !== undefined && app.clientId !== undefined && app.clientSecret !== undefined;
    const link = canRedirect ? authorizeUrl(app.clientId ?? '', scopes, redirect.uri, redirect.state) : installPageUrl(app.appId);
    io.say(`Now install the app to your workspace: ${link}`);
    await ctx.openUrl(link);
    const outcome = await io.choose({
      id: 'install',
      text: 'Did Slack let you install it?',
      choices: [
        { id: 'installed', label: 'Yes, it is installed' },
        { id: 'approval', label: 'No, it says an admin has to approve it ("Request to install")' },
      ],
      default: 'installed',
      why: 'Some workspaces make members ask an admin before an app is added. That is fine: the request goes to them, and the steps that do not need the bot go on meanwhile.',
    });
    if (outcome === 'approval') {
      const requestLink = installPageUrl(app.appId);
      io.say(`Click "Request to install" at ${requestLink} and tell your Slack admin to approve it. I will carry on with the steps that do not need the bot; run onboarding again once it is approved.`);
      return { blocked: { status: 'blocked', on: 'a Slack workspace admin', reason: 'the app is created, but a Slack admin has to approve the install; run onboarding again once they have', link: requestLink } };
    }
    if (canRedirect) {
      io.say('Waiting for Slack to send you back (up to 3 minutes)...');
      const code = await redirect.listener.wait(deps.redirectWaitMs ?? 180_000);
      if (code !== undefined) {
        try {
          const raw = await exchangeCode(base, { clientId: app.clientId ?? '', clientSecret: app.clientSecret ?? '' }, code, redirect.uri);
          const token = new SecretValue(raw);
          const check = await checkBotToken(base, token);
          if (check.status === 'ok') return { token, bot: check.value };
        } catch {
          // Fall through to the paste.
        }
      }
      io.say('Slack did not send the install back to Snapwing, so I will ask you to copy the token instead.');
    }
    return pasteBotToken(ctx, app.appId);
  }

  /** The app-level token, by paste, until Slack accepts it for Socket Mode. */
  async function askAppToken(ctx: StepContext, appId: string): Promise<SecretValue> {
    ctx.io.say(NO_APP_TOKEN_API);
    ctx.io.say(`Create it at ${APP_TOKEN_PAGE(appId)}; the token starts with xapp-.`);
    await ctx.openUrl(APP_TOKEN_PAGE(appId));
    return ctx.io.secret({
      id: 'app-token',
      text: 'Paste the app-level token.',
      why: 'Socket Mode lets Slack reach Snapwing without a public address; this token opens that connection. It is stored only in your .env file.',
      validate: async (answer) => {
        if (!answer.reveal().startsWith('xapp-')) return 'An app-level token starts with xapp-. Copy the one you just created.';
        const check = await checkAppToken(base, answer);
        if (check.status === 'ok') return undefined;
        return check.status === 'rejected'
          ? 'Slack did not accept that token. Check that it has the connections:write scope and copy it again.'
          : 'I could not reach Slack to check that token. Check your connection and paste it again.';
      },
    });
  }

  /** Which channels the bot watches: asks, joins the public ones, and asks for an invite to the private ones. */
  async function chooseChannels(ctx: StepContext, token: SecretValue): Promise<{ channels: SavedChannel[]; pending: string[] }> {
    const { io } = ctx;
    let all = await listChannels(base, token);
    const publics = all.filter((c) => !c.isPrivate);
    const channels: SavedChannel[] = [];
    const pending: string[] = [];

    if (publics.length === 0) {
      io.say('I do not see any public channels yet.');
    } else {
      io.say('These are the public channels I can see:');
      for (const c of publics) io.say(`  #${c.name}`);
      let chosen: SlackChannel[] = [];
      await io.ask({
        id: 'channels',
        text: 'Which of them do people report bugs in? Type their names, separated by commas, or "none".',
        why: 'Snapwing joins each one you name so it can read the thread when someone reacts with the bug emoji. You can change this later.',
        validate: (answer) => {
          const names = toNames(answer);
          if (names.length === 0) return 'Type at least one channel name, or "none".';
          if (names.length === 1 && names[0] === 'none') {
            chosen = [];
            return undefined;
          }
          const unknown = names.filter((n) => !publics.some((c) => c.name === n));
          if (unknown.length > 0) return `I do not see ${unknown.map((n) => `#${n}`).join(', ')} in the list. Type the names as shown.`;
          chosen = names.flatMap((n) => publics.filter((c) => c.name === n));
          return undefined;
        },
      });
      for (const c of chosen) {
        if (c.isMember || (await joinChannel(base, token, c.id))) {
          channels.push({ id: c.id, name: c.name, private: false });
        } else {
          io.say(`I could not join #${c.name}. Type /invite @${APP_NAME} in it.`);
          pending.push(c.name);
        }
      }
    }

    const hasPrivate = await io.choose({
      id: 'private',
      text: 'Do people report bugs in any private channels too?',
      choices: [
        { id: 'no', label: 'No, public channels only' },
        { id: 'yes', label: 'Yes, there are private ones' },
      ],
      default: 'no',
      why: 'A bot cannot see a private channel until someone invites it, and Snapwing will not ask for more access than you give it here.',
    });
    if (hasPrivate === 'yes') {
      const names = toNames(
        await io.ask({
          id: 'private-channels',
          text: 'Which private channels? Type their names, separated by commas.',
          validate: (answer) => (toNames(answer).length === 0 ? 'Type at least one channel name.' : undefined),
        }),
      );
      io.say(`In each of those channels, type /invite @${APP_NAME} (or add it from the channel's Integrations tab).`);
      await io.choose({
        id: 'invited',
        text: 'Have you invited it to all of them?',
        choices: [
          { id: 'done', label: 'Yes, check now' },
          { id: 'later', label: 'Not yet; I will do it later' },
        ],
        default: 'done',
        why: 'I check by listing the channels the bot is in. Any it is not in yet are kept as waiting for an invite.',
      });
      all = await listChannels(base, token);
      for (const n of names) {
        const found = all.find((c) => c.name === n && c.isPrivate && c.isMember);
        if (found !== undefined) channels.push({ id: found.id, name: found.name, private: true });
        else {
          io.say(`I am not in #${n} yet, so I cannot read it. Invite ${APP_NAME} there and run this step again.`);
          pending.push(n);
        }
      }
    }
    return { channels, pending };
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const saved = ctx.data('slack');
    let appId = typeof saved?.['appId'] === 'string' ? saved['appId'] : undefined;
    const manifest = manifestForCreate(undefined, deps.manifestPath);
    const scopes = botScopesOf(manifest);
    const publicUrl = (await ctx.readEnv('SNAPWING_PUBLIC_URL'))?.reveal();
    const wantsRedirect = publicUrl !== undefined && /^https:\/\//.test(publicUrl);
    if (saved === undefined) io.say('Now Slack, where bugs will be reported.');

    // ---- a saved bot token, re-checked --------------------------------------------------------
    let token: SecretValue | undefined;
    let bot: BotIdentity | undefined;
    const savedToken = await ctx.readEnv('SLACK_BOT_TOKEN');
    if (savedToken !== undefined && appId !== undefined && saved?.['installed'] === true) {
      const check = await checkBotToken(base, savedToken);
      if (check.status === 'ok') {
        const keep = await io.choose({
          id: 'keep',
          text: `Slack: keep using the saved connection to ${check.value.team === '' ? 'your workspace' : check.value.team}?`,
          choices: [
            { id: 'keep', label: 'Yes, keep it' },
            { id: 'change', label: 'No, connect again' },
          ],
          default: 'keep',
          why: 'The saved bot token is in your .env file and Slack still accepts it. Connecting again installs the app once more and asks for the tokens again; the saved ones stay until Slack accepts the new ones.',
        });
        if (keep === 'keep') {
          token = savedToken;
          bot = check.value;
        }
      } else if (check.status === 'rejected') {
        io.say('Slack no longer accepts the saved bot token, so I need it again.');
      } else {
        const next = await io.choose({
          id: 'unreachable',
          text: 'I could not reach Slack to check the saved connection. Stop here and try again later, or connect again?',
          choices: [
            { id: 'later', label: 'Stop here; I will run onboarding again later' },
            { id: 'change', label: 'Connect again' },
          ],
          default: 'later',
          why: 'Slack did not answer (no connection, a firewall, or Slack is down), so the saved connection may well be fine.',
        });
        if (next === 'later') throw new Error('could not reach Slack to check the saved connection; check the connection, then run onboarding again');
      }
    }

    if (token === undefined || bot === undefined) {
      // ---- the app -------------------------------------------------------------------------------
      const state = randomBytes(16).toString('hex');
      const redirectUri = wantsRedirect ? `${publicUrl.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}` : undefined;
      const listener = redirectUri === undefined ? undefined : await listen(DEFAULT_PORT, state);
      let clientId = await ctx.readEnv('SLACK_CLIENT_ID');
      let clientSecret = await ctx.readEnv('SLACK_CLIENT_SECRET');
      try {
        const registered = appId !== undefined && saved?.['redirect'] === true;
        if (appId === undefined) {
          const created = await createFromManifest(ctx, manifestForCreate(listener === undefined ? undefined : redirectUri, deps.manifestPath));
          appId = created.appId;
          clientId = new SecretValue(created.clientId);
          clientSecret = new SecretValue(created.clientSecret);
          await ctx.writeEnv({
            SLACK_SIGNING_SECRET: new SecretValue(created.signingSecret),
            SLACK_CLIENT_ID: created.clientId,
            SLACK_CLIENT_SECRET: clientSecret,
          });
          await ctx.progress({ appId, redirect: listener !== undefined });
          io.say('The Slack app is created.');
        } else {
          io.say('The Slack app is already created; I will pick up at the install.');
        }
        // A resumed app only catches the redirect when the first run registered the address.
        const usable = listener !== undefined && (registered || saved?.['appId'] === undefined);
        const result = await install(
          ctx,
          {
            appId,
            ...(clientId === undefined ? {} : { clientId: clientId.reveal() }),
            ...(clientSecret === undefined ? {} : { clientSecret: clientSecret.reveal() }),
          },
          usable && redirectUri !== undefined && listener !== undefined ? { uri: redirectUri, state, listener } : undefined,
          scopes,
        );
        if ('blocked' in result) return result.blocked;
        token = result.token;
        bot = result.bot;
      } finally {
        listener?.close();
      }
      await ctx.writeEnv({ SLACK_BOT_TOKEN: token });
      await ctx.progress({ installed: true, team: bot.team, teamId: bot.teamId, botUserId: bot.userId });
    }
    io.say(`Connected to Slack${bot.team === '' ? '' : ` workspace ${bot.team}`}.`);

    // ---- the one-install check (a warning, never a stop) ------------------------------------------
    try {
      const others = await findOtherBots(base, token.reveal(), bot.userId);
      if (others.length > 0) io.say(`Heads up: ${duplicateBotWarning(others)}. I am carrying on, but check that the old one is not still running.`);
    } catch {
      io.say(`I could not check whether another bot named ${APP_NAME} is in the workspace; carrying on.`);
    }

    // ---- the app-level token ------------------------------------------------------------------------
    const savedApp = await ctx.readEnv('SLACK_APP_TOKEN');
    let appToken: SecretValue | undefined;
    if (savedApp !== undefined) {
      const check = await checkAppToken(base, savedApp);
      if (check.status !== 'rejected') appToken = savedApp;
      else io.say('Slack no longer accepts the saved app-level token, so I need it again.');
    }
    if (appToken === undefined) {
      appToken = await askAppToken(ctx, appId ?? '');
      await ctx.writeEnv({ SLACK_APP_TOKEN: appToken });
    }

    // ---- the channels ----------------------------------------------------------------------------------
    const { channels, pending } = await chooseChannels(ctx, token);
    const data: JsonObject = {
      appId: appId ?? '',
      team: bot.team,
      teamId: bot.teamId,
      botUserId: bot.userId,
      installed: true,
      channels: channels.map((c) => ({ id: c.id, name: c.name, private: c.private })),
      ...(pending.length > 0 ? { waitingForInvite: pending } : {}),
    };
    return { status: 'done', data };
  }

  return { id: 'slack', title: 'Connect Slack', needs: ['runtime'], run };
}

export const slackStep: OnboardStep = createSlackStep();
