import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppConfigError, loadAppConfig, MODEL_TASKS, validateAppConfig } from '../../src/config/app-config.ts';

const example = readFileSync(fileURLToPath(new URL('../../../../examples/snapwing.config.example.xml', import.meta.url)), 'utf8');

describe('app-config.xsd', () => {
  it('validates the main 14.5 example', async () => {
    expect(await validateAppConfig(example)).toEqual({ valid: true, errors: [] });
  });

  it('accepts ISO 8601 durations with days and combined parts', async () => {
    for (const d of ['PT30M', 'PT1H30M', 'P1D', 'P1DT12H', 'PT0.5S']) {
      expect((await validateAppConfig(example.replace('timeout="PT30M"', `timeout="${d}"`))).valid, d).toBe(true);
    }
  });

  it('rejects a provider outside anthropic|openai|google', async () => {
    const result = await validateAppConfig(example.replace('provider="openai"', 'provider="mistral"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/provider/);
  });

  it('rejects a task outside the six ModelTask values', async () => {
    const result = await validateAppConfig(example.replace('task="scout"', 'task="summarize"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/task/);
  });

  it('rejects a non-ISO duration', async () => {
    for (const d of ['30 minutes', '30m', 'PT', 'P1DT']) {
      const result = await validateAppConfig(example.replace('timeout="PT30M"', `timeout="${d}"`));
      expect(result.valid, d).toBe(false);
      expect(result.errors[0]?.message).toMatch(/timeout/);
    }
  });

  it('rejects two rows for one task', async () => {
    const result = await validateAppConfig(example.replace('task="vision"', 'task="triage"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/OneModelPerTask|Duplicate/i);
  });
});

describe('loadAppConfig', () => {
  it('returns typed runtime, models, and harness for the example', () => {
    const config = loadAppConfig(example);
    expect(config.runtime).toEqual({ provider: 'local' });
    expect(config.models.defaultProvider).toBe('anthropic');
    expect(config.models.rows).toHaveLength(6);
    expect(config.models.rows.map((r) => r.task)).toEqual([...MODEL_TASKS]);
    expect(config.models.rows.find((r) => r.task === 'review')).toEqual({ task: 'review', provider: 'google', name: 'gemini-2.5-pro' });
    expect(config.harness).toEqual({
      fixer: 'claude-code',
      review: 'generic',
      generic: [{ id: 'aider', command: 'aider --yes --message-file - --json-result', timeout: 'PT30M' }],
    });
  });

  it('carries the pinned models and the token caps the model proxy enforces (#273), and refuses a bad cap', async () => {
    const xml = example.replace('<harness fixer="claude-code" review="generic">', '<harness fixer="claude-code" review="generic" fixer-model="claude-opus-5-5" review-model="claude-sonnet-5-5" max-tokens="16000" max-run-tokens="2000000">');
    expect(await validateAppConfig(xml)).toEqual({ valid: true, errors: [] });
    expect(loadAppConfig(xml).harness).toMatchObject({ fixerModel: 'claude-opus-5-5', reviewModel: 'claude-sonnet-5-5', maxTokens: 16000, maxRunTokens: 2000000 });
    const bad = xml.replace('max-tokens="16000"', 'max-tokens="0"');
    expect((await validateAppConfig(bad)).valid).toBe(false);
    expect(() => loadAppConfig(bad)).toThrow(/max-tokens="0"> must be a positive integer/);
  });

  it('defaults the generic timeout to PT30M and carries the region', () => {
    const xml = example
      .replace('<runtime provider="local"/>', '<runtime provider="aws" region="us-east-2"/>')
      .replace(' timeout="PT30M"', '');
    const config = loadAppConfig(xml);
    expect(config.runtime).toEqual({ provider: 'aws', region: 'us-east-2' });
    expect(config.harness.generic[0]?.timeout).toBe('PT30M');
  });

  it('rejects malformed XML, a wrong root, and a bad enumeration', () => {
    expect(() => loadAppConfig('<snapwing')).toThrow(AppConfigError);
    expect(() => loadAppConfig('<snapwing version="1"/>')).toThrow(/root element/);
    expect(() => loadAppConfig(example.replace('provider="openai"', 'provider="mistral"'))).toThrow(/model provider "mistral" must be one of/);
  });

  it('rejects duplicate tasks, bad durations, and generic without a template', () => {
    expect(() => loadAppConfig(example.replace('task="vision"', 'task="triage"'))).toThrow(/more than one <model> row/);
    expect(() => loadAppConfig(example.replace('timeout="PT30M"', 'timeout="30m"'))).toThrow(/not an ISO 8601 duration/);
    expect(() => loadAppConfig(example.replace(/<generic [^>]*\/>/, ''))).toThrow(/declares no <generic>/);
  });

  it('reads an optional <model> temperature from 0 to 2, in the XSD and the loader', async () => {
    const withTemp = (t: string) => example.replace('task="triage"', `task="triage" temperature="${t}"`);
    expect(loadAppConfig(withTemp('0.2')).models.rows.find((r) => r.task === 'triage')).toMatchObject({ temperature: 0.2 });
    expect(loadAppConfig(example).models.rows.find((r) => r.task === 'triage')).not.toHaveProperty('temperature');
    expect((await validateAppConfig(withTemp('0'))).valid).toBe(true);
    for (const bad of ['-1', '2.5', 'warm', '']) {
      expect((await validateAppConfig(withTemp(bad))).valid, bad).toBe(false);
      expect(() => loadAppConfig(withTemp(bad)), bad).toThrow(/temperature/);
    }
  });

  it('reads <models refusal-fallback>, on by default, in the XSD and the loader', async () => {
    const withMode = (m: string) => example.replace('<models ', `<models refusal-fallback="${m}" `);
    expect(loadAppConfig(example).models.refusalFallback).toBe(true);
    expect(loadAppConfig(withMode('on')).models.refusalFallback).toBe(true);
    expect(loadAppConfig(withMode('off')).models.refusalFallback).toBe(false);
    for (const ok of ['on', 'off']) expect(await validateAppConfig(withMode(ok)), ok).toEqual({ valid: true, errors: [] });
    for (const bad of ['no', 'false', 'default', '']) {
      expect((await validateAppConfig(withMode(bad))).valid, bad).toBe(false);
      expect(() => loadAppConfig(withMode(bad)), bad).toThrow(/refusal-fallback/);
    }
  });

  it('reads <jira> status overrides and defaults to none', async () => {
    expect(loadAppConfig(example).jira).toEqual({ statuses: {} });
    expect(loadAppConfig(example.replace('<jira/>', '')).jira).toEqual({ statuses: {} });
    const xml = example.replace(
      '<jira/>',
      '<jira><status logical="backlog" name="Selected for Development"/><status logical="in-review" name="Code Review"/></jira>',
    );
    expect(await validateAppConfig(xml)).toEqual({ valid: true, errors: [] });
    expect(loadAppConfig(xml).jira).toEqual({ statuses: { backlog: 'Selected for Development', 'in-review': 'Code Review' } });
  });

  it('rejects an unknown logical target and a target named twice, in the XSD and the loader', async () => {
    const unknown = example.replace('<jira/>', '<jira><status logical="triage" name="Triage"/></jira>');
    expect((await validateAppConfig(unknown)).valid).toBe(false);
    expect(() => loadAppConfig(unknown)).toThrow(/<jira> status logical "triage" must be one of backlog, in-progress, in-review, done/);
    const twice = example.replace('<jira/>', '<jira><status logical="done" name="Done"/><status logical="done" name="Closed"/></jira>');
    expect((await validateAppConfig(twice)).valid).toBe(false);
    expect(() => loadAppConfig(twice)).toThrow(/more than once/);
  });
});
