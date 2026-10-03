import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CaptureConfigError } from './errors.ts';

export interface ClientConfig {
  readonly endpoint: string;
  readonly token: string;
}

export interface LoadClientConfigOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export function clientConfigPath(home: string): string {
  return join(home, '.config', 'snapwing', 'client.json');
}

function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

async function readFileConfig(path: string): Promise<{ endpoint?: string; token?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return {};
    throw new CaptureConfigError(`Cannot read ${path}.`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CaptureConfigError(`${path} is not valid JSON.`, { cause });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CaptureConfigError(`${path} must hold a JSON object.`);
  }
  const rec = raw as Readonly<Record<string, unknown>>;
  const endpoint = rec['endpoint'];
  const token = rec['token'];
  return {
    ...(typeof endpoint === 'string' && endpoint.length > 0 ? { endpoint } : {}),
    ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
  };
}

/**
 * `SNAPWING_URL` and `SNAPWING_TOKEN` win, field by field; the rest comes from
 * `~/.config/snapwing/client.json`. Returns undefined until both are known.
 */
export async function loadClientConfig(options: LoadClientConfigOptions): Promise<ClientConfig | undefined> {
  const envUrl = options.env['SNAPWING_URL'];
  const envToken = options.env['SNAPWING_TOKEN'];
  const fromEnvUrl = envUrl !== undefined && envUrl !== '' ? envUrl : undefined;
  const fromEnvToken = envToken !== undefined && envToken !== '' ? envToken : undefined;
  const file =
    fromEnvUrl !== undefined && fromEnvToken !== undefined ? {} : await readFileConfig(clientConfigPath(options.home));
  const endpoint = fromEnvUrl ?? file.endpoint;
  const token = fromEnvToken ?? file.token;
  if (endpoint === undefined || token === undefined) return undefined;
  if (!validEndpoint(endpoint)) throw new CaptureConfigError(`The endpoint ${endpoint} is not an http or https URL.`);
  return { endpoint, token };
}

/** Writes `~/.config/snapwing/client.json` with mode 0600 (directory 0700), also tightening an older file. */
export async function saveClientConfig(config: ClientConfig, options: { readonly home: string }): Promise<string> {
  if (!validEndpoint(config.endpoint)) {
    throw new CaptureConfigError(`The endpoint ${config.endpoint} is not an http or https URL.`);
  }
  if (config.token.length === 0) throw new CaptureConfigError('The token is empty.');
  const path = clientConfigPath(options.home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ endpoint: config.endpoint, token: config.token }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}
