# Spec index

Maps spec sections to the package and directory that implements them, so an issue can say `spec: A 4.3` and an agent can jump straight to the code. Paths are relative to `packages/` unless they start with `schemas/`, `manifests/`, or `demo/`.

| Spec | Section | Package / path |
|---|---|---|
| main | 4 | pipeline/src/map, schemas/workspace-context.* |
| main | 4.4 | pipeline/src/resolve |
| main | 4.6 | pipeline/src/policy/autonomy.ts |
| main | 5 | pipeline/src/context |
| main | 5.2a | pipeline/src/context/vision |
| main | 6 | pipeline/src/dedupe |
| main | 7 | pipeline/src/clarify |
| main | 8 | pipeline/src/triage |
| main | 9 | pipeline/src/jira (synthesis), pipeline/src/prompts, schemas/implementation-request.xsd |
| main | 9, 10 | pipeline/src/triage, pipeline/src/fixer |
| main | 11 | pipeline/src/review, pipeline/src/merge |
| main | 12 | app/src/status |
| main | 13 | pipeline/src/contracts, pipeline/src/util/{ulid,duration}.ts |
| (all) | XML | pipeline/src/schemas/validate.ts (XSD + Schematron runner), schemas/*, examples/* |
| main | 14.1 | pipeline/src/engine |
| main | 14.2 | pipeline/src/engine/idempotency.ts |
| main | 14.3 | pipeline/src/ports/{queue,cache,secrets,object-store,runner}.ts, pipeline/src/providers/local (in-memory, demo), app/src/providers/{docker,aws,gcp} |
| main | 14.3 (demo) | pipeline/src/demo, demo/ |
| main | 14.3 (config) | pipeline/src/config/app-config.ts, schemas/app-config.xsd |
| main | 14.4 | scripts/*-bootstrap.ts, packages/*/test/{live,e2e} |
| main | 14.5 ModelPort | pipeline/src/ports/model.ts, pipeline/src/models/{anthropic,openai,google,mock} |
| main | 14.5 HarnessPort | pipeline/src/ports/harness.ts, pipeline/src/harness/{claude-code,codex,gemini,generic} |
| main | 15 | app/src/adapters/{slack,teams,raycast,cli,alerts} |
| main | 15.1, 15.2, 22 | app/src/onboard/{slack,teams,github,jira}, app/src/onboard/interview, manifests/{slack,teams} |
| main | 16 | pipeline/src/policy/authorize.ts |
| main | 20.3 | console |
| main | 20.4 | replay |
| main | 21 | packages/* (boundaries in main 21.1) |
| A | 1, 2, 3 | pipeline/src/signals |
| A | 4 | app/src/status, pipeline/src/monitor |
| A | 5 | pipeline/src/context/vision |
| A | 6 | pipeline/src/config, schemas/playbook.xsd |
| A | 7 | pipeline/src/contracts |
| B | 1 | pipeline/src/ports/{state,workflow}.ts |
| B | 2 | pipeline/src/state/{sqlite,postgres}, pipeline/src/workflow/{inprocess,pgboss} |
| B | 3 | pipeline/src/state/migrations |
| B | 4 | pipeline/src/state/events.ts, pipeline/src/state/projections |
| B | 5 | pipeline/src/lifecycle |
| B | 6 | pipeline/src/coordinate |
| B | 7 | app/src/jira/projector |
| B | 8 | app/src/webhooks |
| B | 9 | app/src/fixer-api |
| B | 10 | app/src/cli/state.ts |
| B | 11 | packages/pipeline/test/contract, demo/ |
