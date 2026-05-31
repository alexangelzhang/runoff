# Release publish checklist

After creating the GitHub repository:

1. Set `origin` and push `main`.
2. Replace README clone URL (`<repo-url>` → real HTTPS clone URL).
3. Add CI badge to README:
   `![CI](https://github.com/ORG/REPO/actions/workflows/ci-gates.yml/badge.svg)`
4. Run `npm run smoke:real:pre-release` on a protected runner; note date in `CHANGELOG.md`.
5. Tag `v*` — **Release workflow** runs `ci:gates` then **pre-release smoke** (self-hosted, no allow-skip) before creating the GitHub Release. Tags will fail until runner + secrets are configured (intentional).
6. Update [supported-backends.md](reference/supported-backends.md) with the smoke pass date.
7. Tick CI badge item in [OPEN_SOURCE.md](reference/OPEN_SOURCE.md).

See [ci-branch-protection.md](operations/ci-branch-protection.md) for when to make PR `smoke` required vs allow-skip.
