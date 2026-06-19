# Contributing to Sovereign Portal

Thanks for considering a contribution. Sovereign Portal is a reference implementation of the Sovereign Software approach, and the bar for what lands in the main repos is deliberately high. This document explains what we accept, how to submit, and where to point things that don't belong here.

If you are looking for support rather than contributing, see [SUPPORT.md](SUPPORT.md).

---

## What belongs in this repo

This repo is the **reference implementation**. Pull requests are graded against one question:

> Does this make the reference clearer, more correct, or more portable?

If the answer is yes — bug fixes, documentation improvements, conformance-suite gaps, performance work, accessibility fixes — open a PR.

If the answer is no, see "What doesn't belong here" below.

### Specifically welcome

- **Bug fixes** in the framework core, the foundational modules (Users / Customers / Workspaces), `portal-shell`, or `module-template`.
- **Documentation clarifications.** If a sentence in the docs misled you, the doc is wrong — open a PR even if the code is fine.
- **Conformance-suite additions** that catch a real-world mistake. See `docs/anti-patterns.md` for the kinds of mistakes worth catching.
- **Auth adapter implementations** for identity providers we haven't shipped (Auth0, Okta, Clerk, Cognito, custom SAML/OIDC).
- **Storage adapter implementations** (we ship Mongo; Postgres is the obvious next one).
- **Performance work** in any of the above, with a benchmark.
- **Accessibility fixes** in the reference UI. Sovereign Portal is meant to be the working foundation people ship from, and that means it needs to clear basic WCAG bars out of the box.

### What doesn't belong here

- **New business modules.** Orders, Pricing, Locations, Billing, Inventory — none of them ship in this repo by design. They are what you build on top. The `module-template` shows you how. Build them in your own repos.
- **Hosted-service features.** We are not building a SaaS. PRs that add deployment automation, billing UI, or anything that assumes Sovereign Portal is being run as a service for someone else's customers are out of scope.
- **Opinionated theming.** The reference UI is intentionally neutral — black/white/grey on the public release, with a single accent for branded deployments. If you want a different look, that's what your own fork is for, not the reference.
- **Closed-source dependencies.** Every dependency added to this repo must be Apache-2.0-compatible. We will not accept BSL, FSL, SSPL, or anything that restricts commercial reuse of the framework.

When in doubt, **open an issue first.** A 30-second issue saves a 30-hour PR review.

---

## Before you start

Three things you should read before opening a non-trivial PR:

1. **`docs/smi-spec.md`** — the contract every change has to honor.
2. **`docs/anti-patterns.md`** — the mistakes already in the codebase's past. If your PR re-introduces one, it gets closed with a link to the relevant section.
3. **`docs/4-layer-permission-model.md`** — the conceptual model. If your change is "the framework should have a fifth layer," read this first; it's almost certainly not the answer.

---

## How to submit

### For small changes (typos, single-file bug fixes, doc clarifications)

Just open the PR. The CI will run the conformance suite and the type checks. Reviewer will pick it up within a week.

### For larger changes (new module-template features, new adapters, architectural changes)

1. **Open an issue first** describing what you want to change and why. Wait for a maintainer to acknowledge the direction before writing code.
2. **Fork, branch, build.** Run the conformance suite locally:
   ```bash
   sovereign-portal verify ./packages/users
   sovereign-portal verify ./packages/companies
   sovereign-portal verify ./packages/workspaces
   sovereign-portal verify ./packages/module-template
   ```
   All must pass.
3. **Open the PR** linking the issue. Include:
   - What changed and why
   - What the conformance suite output looks like
   - Screenshots if you changed any UI
   - Any breaking changes (we are pre-1.0; breaking is OK but must be explicit)

### Code style

- TypeScript strict mode. `tsc --strict --noEmit` must pass cleanly.
- Two-space indent, semicolons, double quotes. (Prettier config in the repo is the source of truth.)
- One module = one folder. No "shared utils" trees that grow into a god package.
- If you touch a file, leave it conformant to these conventions even if it wasn't before.

### Commit messages

```
<scope>: <one-line summary>

<optional longer body>

Closes #<issue> (if applicable)
```

Examples:
- `users-be: stop reading session cookies directly (anti-pattern §5)`
- `docs/smi-spec: clarify dataScope ScopeFilter return shape`
- `module-template: add example of cross-module peer call`

---

## What we look for in code review

- **Does it conform?** Run `sovereign-portal verify`. The suite is the contract.
- **Does it respect sovereignty?** No cross-module data reads, no hardcoded peer service names, no auth header reads outside the adapter. See `docs/anti-patterns.md`.
- **Is it tested?** New behaviour needs new tests. Bug fixes need a regression test. Pure doc PRs can skip this.
- **Is it documented?** New public surface (functions, types, settings) needs doc updates in the same PR.

Reviewers are direct. If something is wrong, they will say so. This is not personal — it is how the bar gets and stays high. Push back if you disagree; that's how design conversations work. We are not precious about anyone's specific implementation, including our own.

---

## Reporting bugs

For ordinary bugs, [open an issue](../../issues/new?template=bug_report.md). The template asks for the minimum repro and the actual vs. expected behaviour.

For security bugs, **do not open a public issue.** See [SECURITY.md](SECURITY.md) for the responsible-disclosure process.

---

## When community contribution isn't the right path

Some changes are out of scope for the reference implementation but valuable for your specific deployment. Examples:

- "I want Sovereign Portal to support our custom IDP and our custom audit-log destination and our specific branded theme and..." — that's a deployment, not a framework change. The framework supports it through adapters and theming; the customization itself is yours to own.
- "We need a sovereign module for our specific business problem and we don't have the team to build it." — see [SUPPORT.md](SUPPORT.md) for the paths Freshify offers (per-module design + build engagement).
- "We need SLA-bound response on issues for our regulated industry deployment." — community support is best-effort. See [SUPPORT.md](SUPPORT.md) for the retainer options.

None of these are failures of the open-source model. They are exactly the cases the open-source / commercial split is built for.

---

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Read it before participating.

---

## Licensing of contributions

By contributing to this repo, you agree your contributions are licensed under the same Apache 2.0 license as the project itself. We do not require a CLA — the Apache 2.0 license includes the patent and copyright grants we need.

If your employer claims rights to code you write, get sign-off before contributing. We will not be the ones telling your legal team you contributed company code without authorization.

---

*Thanks for reading. The faster you can match the bar, the faster your PR lands.*
