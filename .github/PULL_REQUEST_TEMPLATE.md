<!--
Thank you for contributing to Sovereign Portal.

Read CONTRIBUTING.md before opening. The grading question for every PR is:

  "Does this make the reference clearer, more correct, or more portable?"

If the answer is no, the PR probably belongs in your own module, not in this repo.

If this is a substantial change (new feature, API change, new module surface), open a feature request issue FIRST and get alignment before writing code. We close large unsolicited PRs without review.
-->

## What this changes

<!-- One paragraph. What does this PR do? -->

## Why

<!-- Why is this needed? Link the issue this PR closes, if any: `Closes #123` -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes a defect)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (API change, requires major-version bump + deprecation note)
- [ ] Documentation only
- [ ] Refactor / internal cleanup (no behavior change)
- [ ] Test additions or fixes

## Scope check

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] This change makes the reference clearer, more correct, or more portable
- [ ] This is not solving a problem specific to one deployment
- [ ] An issue exists for this change OR the change is small enough to not require one (docs, typo, small bug)

## Tests

- [ ] Existing tests pass locally
- [ ] I added tests for the new behavior, or explained below why tests aren't applicable

<!-- If no tests, explain why: -->

## Backward compatibility

- [ ] No breaking changes to public APIs (SMI surface, registry shape, permission contract, settings shape)
- [ ] If there are breaking changes, I have:
  - [ ] Added a deprecation note in the relevant doc
  - [ ] Updated the upgrade guide
  - [ ] Bumped the major version in the affected package(s)

## Documentation

- [ ] README, quickstart, SMI spec, 4-layer model, registry+settings, or anti-patterns updated where relevant
- [ ] Inline code comments updated where the change is non-obvious
- [ ] No new undocumented public APIs

## Security

- [ ] No new authentication / authorization paths without 4-layer permission checks
- [ ] No new logged values containing tokens, secrets, or PII
- [ ] No new external network calls without explicit configuration
- [ ] If this touches identity, tenancy, or audit, I have read the relevant anti-patterns

## Screenshots / output

<!-- If this is a UI change, paste before/after screenshots. If this is a CLI or log change, paste sample output. -->

---

<sub>Need help getting this PR over the line, or have a deployment-specific change you want built into your fork? See [SUPPORT.md](../SUPPORT.md) — Freshify builds sovereign modules and reviews architectures under the Advantage Retainer.</sub>
