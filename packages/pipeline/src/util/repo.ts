// Repository names. The workspace map writes a surface's repo as `github.com/owner/name` (main 4.2),
// and that is what an incident records; GitHub's REST paths, installation tokens, clone URLs, webhook
// payloads (`repository.full_name`), and the fixer checkout all use `owner/name`. Every GitHub call
// goes through `repoFullName` first, and a webhook compares repos with `sameRepo`. Moved here from
// the app so the fixer and review checkouts (`fixer/workdir`) take the map's form too.

/** `owner/name` for `owner/name`, `github.com/owner/name`, `https://github.com/owner/name(.git)`, or `git@github.com:owner/name.git`. */
export function repoFullName(repo: string): string {
  return repo
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/** Whether two repo references name the same GitHub repository (GitHub names are case-insensitive). */
export function sameRepo(a: string | undefined, b: string): boolean {
  return a !== undefined && repoFullName(a).toLowerCase() === repoFullName(b).toLowerCase();
}
