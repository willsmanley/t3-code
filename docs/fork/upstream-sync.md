# Nightly upstream sync

An agent runs this every night. It merges upstream T3 Code (`pingdotgg/t3code` main) into this
fork's `main` (`willsmanley/t3-code`), keeps every fork feature working, and builds and publishes
the nightly release on its own machine with `scripts/fork/nightly-release.sh`. The workflow
`.github/workflows/custom-nightly-linux.yml` makes the same release on GitHub Actions; its schedule
is only a fallback that builds `main` on a night this job missed, when Actions is enabled.

## Rules

- Push only to the fork. Never push to, open pull requests on, or comment on `pingdotgg/t3code`.
- Never force-push or rewrite the fork's `main`. Merge upstream in; don't rebase the fork.
- Every feature in [features.md](features.md) must still work afterwards. If upstream now does
  the same thing, drop the fork's copy and say so in the report.
- Don't push to `main` while a workflow build runs. Publishing a release for a commit that is no
  longer `main` can be refused when the newer commit changes workflow files.
- Follow the repository's `AGENTS.md`: scoped checks only, never repo-wide runs.

## Steps

1. **Fetch both sides.** Here `fork` is willsmanley/t3-code and `origin` is pingdotgg/t3code;
   add either remote if it is missing. Run `git fetch fork main` and
   `git fetch origin +refs/heads/main:refs/remotes/origin/main`, then start a branch at
   `fork/main`.
2. **Update the ledger.** List the fork commits since the last sync:
   `git log --no-merges --oneline "$(git log -1 --first-parent --format=%H --grep='^Merge upstream main' fork/main)"..fork/main`.
   Add any feature they introduce to features.md, with its touch points and a check.
3. **Merge.** If `git merge-base --is-ancestor origin/main HEAD` succeeds, there is nothing new;
   go to step 7. Otherwise run
   `git merge --no-ff -m "Merge upstream main ($(git rev-parse --short origin/main)) into the fork" origin/main`.
   - Resolve each conflict by intent. Read what upstream changed
     (`git log --oneline "$(git merge-base HEAD origin/main)"..origin/main -- <file>`) and what the
     fork's change is for (features.md). Keep upstream's new structure and put the fork's
     behavior back on top of it.
   - Never take one side wholesale (`-X ours`, `checkout --ours/--theirs`) for a file that has
     fork changes. That left code that no longer compiled in October 2026.
   - For `pnpm-lock.yaml`, take upstream's version, run `pnpm install` to add the fork's
     dependencies back, and commit the result.
4. **Check.** Run `pnpm install --frozen-lockfile`, then:
   - `vp run check:changed fork/main`, which covers everything the merge changed;
   - `vp run check:changed origin/main`, which covers everything the fork changes on top of
     upstream, including the fork's own tests.

   Fix what the merge broke. If a failure also happens on upstream main by itself, note it and
   move on unless it blocks the build.

5. **Verify fork features** with the check listed for each one in features.md.
6. **Shrink the overlap (at most one item).** If the merge went smoothly and a file from the
   isolation plan in features.md conflicted tonight, do that refactor as its own commit: move
   the fork logic into a fork-owned file and leave a one-line hook in the upstream file. Check it
   as in step 4 and update features.md.
7. **Push.** Run `git fetch fork main`. If it moved, merge it in and check again. Then
   `git push fork HEAD:main`.
8. **Build.** Unlock Bitwarden so the script can read the Android signing key (`BW_SESSION`),
   then run `ctx-build-governor exec -- scripts/fork/nightly-release.sh` from the sync checkout.
   It builds the fork's `main` in `../nightly-build` (about half an hour), checks the SSH
   runtime and the APK signature, and publishes the prerelease. It does nothing when a release
   already exists for `main`. If it fails because of code, fix it, push, and run it once more.
   If Hostkey can't build, start the workflow instead:
   `gh workflow run custom-nightly-linux.yml -R willsmanley/t3-code --ref main -f merge_upstream=false`,
   then `gh run watch <run-id> -R willsmanley/t3-code --exit-status`.
9. **If you can't finish,** leave `main` alone. Push your work to `sync/upstream-<YYYYMMDD>` on
   the fork so it isn't lost, still run step 8 so `main` builds as it is, and say what blocks
   the merge.
10. **Report** in a few plain lines:
    - the upstream commits merged (range and count);
    - the conflicts and how you resolved them;
    - any fork feature you changed or dropped;
    - the checks you ran;
    - the release link;
    - anything that needs a human decision.
