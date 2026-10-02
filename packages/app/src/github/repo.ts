// Repository names: `repoFullName` and `sameRepo` live in the pipeline (`util/repo.ts`), where the
// fixer and review checkouts use them too; the app's GitHub code imports them from here.

export { repoFullName, sameRepo } from '@snapwing/pipeline/util/repo.ts';
