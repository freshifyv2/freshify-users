# Getting help with Sovereign Portal

Sovereign Portal is open source under Apache 2.0. There is no paywall on the framework itself — you can clone it, run it, ship products built on it, all without paying anyone. This document explains how to get help, ranging from free community support to commercial engagement.

There are three paths. Pick the one that matches what you need.

---

## Path 1 — Community (free)

For curiosity questions, bug reports, design discussions, and "how would you do X" conversations.

- **Bugs in the framework or reference modules** → [open an issue](../../issues/new/choose). See the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- **Feature requests** → [open an issue](../../issues/new/choose) using the feature request template. Read the [contribution scope](CONTRIBUTING.md#what-belongs-in-this-repo) first — most "more features" requests belong in your own module, not in the framework.
- **Questions and architecture discussions** → use [GitHub Discussions](../../discussions). The community answers; we read but do not promise response times.
- **Security issues** → see [SECURITY.md](SECURITY.md). Do **not** open a public issue for security disclosures.

**What community support covers:** clarifying the docs, fixing real bugs, reviewing well-scoped pull requests, answering "how does X work" when X is documented.

**What community support does not cover:** designing your specific deployment, writing your modules for you, debugging your custom code, SLA-bound response, or anything that resembles a paid consulting engagement.

---

## Path 2 — Paid support and architecture retainer

For teams building production deployments who want a human in their corner.

Freshify operates two retainers for Sovereign Portal deployments:

### Advantage Retainer — $4,500/month (6-month minimum)

Architecture review, design feedback, and roadmap guidance. The pattern: you build the modules, we look at the designs before you commit, we catch the structural mistakes before they ship. Monthly review call, async question access, quarterly mini-diagnostic.

If you have one or two architects on your team who are smart but haven't run a sovereign-modular system before, this is the one. It is materially cheaper than learning the same lessons the way we did.

### AI Maintenance Retainer — $3,500–$7,500/month per module set

Once you're in production, trained maintenance agents monitor your sovereign modules, surface drift, and produce a monthly health report. We bridge the gap between "Freshify built it" and "Freshify keeps it alive." Particularly useful for buyers without a permanent platform-engineering team.

### How to engage

Email **support@freshify.io** with a 2-3 sentence summary of your deployment. We respond within two business days. No discovery call required if the fit is obvious from the email.

Or visit [freshify.io](https://freshify.io) for the engagement options across all of Freshify's services.

---

## Path 3 — Have us build it

For teams who would rather buy the modules than build them.

### Sovereign Software Blueprint — $6,500 per platform

A modular audit of your existing system plus a recommended build sequence. Output: a Modular Architecture Map that says exactly which sovereign modules to build first, in what order, and what each costs. Useful before committing to a multi-module rebuild.

### New Sovereign Service Architecture + Design — $6,000 per module

Sovereign module spec, data schema, Figma UX, API contracts. The design package a developer (yours or ours) can build against directly.

### New Sovereign Service Development — $18,000 per module

We build the designed sovereign module. 2–4 weeks, AI-assisted, production-ready. The module ships conformant to the SMI in this repo, so it composes against everything else you have or will have.

### Environment + Documentation Handoff — $2,000 per module

Env setup, runbooks, decision log. Mostly AI-generated, human-reviewed. Usually bundled with the development package.

### How to engage

Email **support@freshify.io** with what you have and what you want. We respond within two business days with a fit assessment and, if relevant, a Software Debt diagnostic (Product 01, $4,500) to scope the work properly before quoting.

---

## What you cannot buy from us

- An SLA on the open-source repo itself. Issues are triaged on a best-effort basis. If you need guaranteed response times, that's what a retainer is for.
- A closed-source license. The framework is Apache 2.0. Always.
- A "hosted Sovereign Portal." We do not run a SaaS. You self-host, on your own cloud, always.

---

## Why this works the way it does

The framework is the marketing. We do not sell it. We sell the experience of building correctly on top of it, the documentation pack that flattens the learning curve, and the architects and modules that ship the system without your team having to grow a platform team to build it.

If you can build it yourself, please do. The docs are the docs we use internally, the conformance suite is the suite we run, and the reference modules are the same code we ship to clients. If your team prefers to spend its time on the business logic and have a partner own the architecture, we are that partner.

Either way is a good outcome. Choose the one that fits.

---

Last updated: June 2026.
