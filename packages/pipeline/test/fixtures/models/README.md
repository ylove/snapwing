# ModelPort HTTP recordings

These are synthetic, sanitized HTTP response recordings authored from the public
API formats, not captures from a paid API call. They exercise the real SDKs via
MSW and the public provider factories registered with createModelRouter. They are
independent of the MockModel prompt-hash fixture format.

## Layout and matching

Each of `anthropic/`, `openai/`, and `google/` contains raw JSON response bodies:

- `complete.json`: a text answer.
- `vision.json`: one structured image reading.
- `valid.json`: a valid classification.
- `invalid.json`: parseable JSON whose label fails the supplied validator.
- `optional.json`: classification with an optional field omitted (Anthropic and
  Google) or nullable (OpenAI's required nullable representation).
- `error-401.json`, `error-429.json`, `error-503.json`: native error envelopes.

The harness matches POST requests to the exact provider origin and endpoint:
`/v1/messages`, `/v1/chat/completions`, or
`/v1beta/models/gemini-2.5-flash:generateContent`. Query parameters are not part of
MSW URL matching. Each test installs an explicit ordered fixture sequence;
classify retry tests consume two responses and assert exactly two HTTP requests.
An exhausted success sequence fails the test. Error responses repeat to accommodate
SDK transport retries, which are distinct from the router's one validation retry.
429 responses have a synthetic `Retry-After: 1` header and must expose 1000 ms.
Other responses use HTTP 200 except the named error status.

MSW rejects unhandled requests. Contract tests supply only `sk-test-fake`, never
environment credentials. Request bodies are captured in memory for image encoding,
retry feedback, and schema assertions. Headers and credentials are not persisted.
The image is a synthetic one-pixel PNG, and its private caller reference must not
appear in a provider request.

## Public format references

- [Anthropic Messages](https://docs.anthropic.com/en/api/messages) and
  [tool response blocks](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls):
  `content`, `tool_use.input`, `stop_reason`, and `usage`.
- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/object):
  `choices[].message.content`, `finish_reason`, and `usage`.
- [Gemini generateContent](https://ai.google.dev/api/generate-content):
  `candidates[].content.parts`, `finishReason`, and `usageMetadata`.
- [OpenAI structured outputs](https://platform.openai.com/docs/guides/structured-outputs):
  strict objects require all properties in `required` and `additionalProperties: false`;
  an optional field can be represented as a required nullable field.

The optional-field contract permits a clear ModelError before any HTTP request.
Otherwise OpenAI must send a strict-compatible schema. Anthropic tool input schemas
and Gemini responseSchema can retain optional properties, so their successful
requests must preserve `note` and require only `label`. These checks use recordings
only. The OpenAI schema assertion currently uses `it.fails` because the outgoing
schema is not normalized. Google's retry-after assertion also uses `it.fails`
because its typed error loses the header. Fixing either adapter makes its expected
failure fail the build until the marker is removed.

## Refreshing recordings

Prefer editing these synthetic bodies against the linked API reference. If a real
capture is necessary, perform it explicitly outside the contract tier with a test
account and synthetic inputs. Capture only the JSON response body, never request
headers, URLs containing credentials, or environment variables. Replace all IDs
with obvious fakes such as `msg_test_0001`, `toolu_test_0001`, and
`chatcmpl-test-0001`; replace identifying content and credentials before writing
anything here. Preserve the native API envelope and usage counters. Never store
secrets, tokens, real credentials, or user data. Manually review the entire diff.
The live suite does not record or write files automatically.

Run `pnpm --dir packages/pipeline exec vitest run test/contract/models` to validate
recordings. The live file is separate at
`test/live/models/model-port.live.test.ts` and reuses the shared port suite. It skips
per provider unless ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY is set.
Live retries use a deliberately rejecting validator, since a live provider cannot
be forced to return invalid output reliably. HTTP error injection, request-body
inspection, exact token counters, and optional-schema checks stay recorded-only.
