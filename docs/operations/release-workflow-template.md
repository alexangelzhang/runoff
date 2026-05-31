# Release Workflow Template

This repository did not have a formal release pipeline yet.
The workflow `.github/workflows/release-template.yml` is a safe default template that chains the new pre-release real-provider gate with normal build, test, package, and optional draft GitHub release steps.

## What it does

When manually triggered, the workflow runs these stages in order:

1. call `.github/workflows/real-provider-smoke-pre-release.yml`
2. run `npm ci`
3. validate `package.json.version` matches the requested `release_version` input
4. run `npm run build`
5. run `npm test`
6. run `npm pack` and upload the generated tarball as a workflow artifact
7. optionally create a draft GitHub release tagged `v<release_version>`

## Trigger inputs

- `release_version`: required, must match `package.json.version`
- `create_github_release`: optional boolean, defaults to `false`

## Assumptions

- The repository is packaged with `npm pack`
- The real provider pre-release gate runs on a self-hosted runner labeled `llm-pipeline-real-smoke`
- Real provider secrets and login state are already prepared as described in `docs/operations/real-provider-smoke-runner-checklist.md`

## Recommended rollout

1. keep `create_github_release=false` for the first few manual dry runs
2. confirm the pre-release smoke gate is green and artifact upload looks correct
3. once stable, either keep this as a manual release entry point or copy its jobs into a more opinionated release pipeline

## How to customize

Replace or extend the packaging section if your final release unit is not an npm tarball.
Common follow-up changes:

- publish to npm after the draft release step
- publish a Docker image instead of or in addition to `npm pack`
- call this workflow from another release orchestration workflow
- require manual environment approval before the draft release job

## Related files

- `.github/workflows/real-provider-smoke-nightly.yml`
- `.github/workflows/real-provider-smoke-pre-release.yml`
- `docs/operations/real-provider-smoke.md`
- `docs/operations/real-provider-smoke-runner-checklist.md`
