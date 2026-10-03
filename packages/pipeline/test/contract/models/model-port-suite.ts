import { expect, it } from 'vitest';
import type { ClassifyRequest, CompletionRequest, ModelPort } from '../../../src/ports/model.ts';
import { ModelValidationError } from '../../../src/models/errors.ts';

export const text = 'Contract response.';
export const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
export const request: CompletionRequest = { task: 'triage', system: '<system>Follow the request precisely.</system>', prompt: '<request>Reply exactly: Contract response.</request>', maxTokens: 1024 };
export interface Classification { label: 'bug' }
export function valid(value: unknown): value is Classification {
  return typeof value === 'object' && value !== null && 'label' in value && value.label === 'bug';
}
export const classification: ClassifyRequest<Classification> = {
  ...request, prompt: '<request>Classify a broken checkout as label bug.</request>', schemaName: 'contract_label',
  schema: { type: 'object', properties: { label: { type: 'string', enum: ['bug'] } }, required: ['label'], additionalProperties: false }, validate: valid,
};
export type Scenario = 'complete' | 'vision' | 'valid' | 'retry' | 'invalid';
export interface ContractCase {
  create: () => ModelPort;
  prepare?: (scenario: Scenario) => void;
  assertRequests?: (count: number, scenario: Scenario) => void;
  assertVision?: () => void;
  live?: boolean;
  /** Base64 PNG for the vision case; default `imageData` (1x1, which the Anthropic API refuses live). */
  visionImage?: string;
}

/** Live mode shares the port assertions, with validator-driven retries instead of HTTP fault injection. */
export function modelPortContract(testCase: ContractCase) {
  it('complete returns the response text', async () => {
    testCase.prepare?.('complete');
    const result = await testCase.create().complete(request);
    expect(result.text.trim()).toBe(text);
    expect(result.model).toMatch(/^(anthropic|openai|google)\//);
    if (!testCase.live) expect(result.usage).toEqual({ inputTokens: 23, outputTokens: 11 });
    testCase.assertRequests?.(1, 'complete');
  }, 60000);

  it('vision returns one structured reading and sends inline image bytes', async () => {
    testCase.prepare?.('vision');
    const result = await testCase.create().vision({ ...request, task: 'vision', prompt: '<request>Describe the image.</request>', images: [{ mimeType: 'image/png', data: testCase.visionImage ?? imageData, ref: 'private-test-image-ref' }] });
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]).toMatchObject({ plainDescription: expect.any(String), sensitive: expect.any(Boolean), uiElements: expect.any(Array) });
    if (!testCase.live) expect(result.readings[0]).toMatchObject({ plainDescription: 'A white square.', sensitive: false, uiElements: [] });
    testCase.assertVision?.();
    testCase.assertRequests?.(1, 'vision');
  }, 60000);

  it('classify validates on the first attempt', async () => {
    testCase.prepare?.('valid');
    const result = await testCase.create().classify(classification);
    expect(result.value).toEqual({ label: 'bug' });
    expect(result.attempts).toBe(1);
    testCase.assertRequests?.(1, 'valid');
  }, 60000);

  it('classify retries once with validation feedback', async () => {
    testCase.prepare?.('retry');
    let validations = 0;
    const result = await testCase.create().classify({ ...classification, validate: testCase.live
      ? (value: unknown): value is Classification => ++validations > 1 && valid(value)
      : valid });
    expect(result.value).toEqual({ label: 'bug' });
    expect(result.attempts).toBe(2);
    testCase.assertRequests?.(2, 'retry');
  }, 60000);

  it('classify rejects invalid output twice with a typed error', async () => {
    testCase.prepare?.('invalid');
    const result = testCase.create().classify({ ...classification, validate: testCase.live ? (_value: unknown): _value is Classification => false : valid });
    await expect(result).rejects.toBeInstanceOf(ModelValidationError);
    await expect(result).rejects.toMatchObject({ task: 'triage', schemaName: 'contract_label', attempts: 2 });
    testCase.assertRequests?.(2, 'invalid');
  }, 60000);
}
