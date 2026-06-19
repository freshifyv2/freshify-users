# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Sovereign Portal, **please do not open a public issue.** Public disclosure before a patch is available puts every deployment at risk.

### How to report

Email **security@freshify.io** with:

- A description of the vulnerability
- Steps to reproduce (or a proof of concept)
- The affected component(s) and version(s)
- Your assessment of impact (data exposure, privilege escalation, denial of service, etc.)
- Whether you have already disclosed this to anyone else

You will receive an acknowledgement within **two business days**. We will work with you to confirm the issue, assess severity, and coordinate a fix and disclosure timeline.

For very sensitive reports, you may PGP-encrypt the email. Our key is available at https://freshify.io/security.asc.

### What you can expect from us

- Acknowledgement within 2 business days
- A severity assessment and rough remediation timeline within 7 days
- Credit in the security advisory (if you want it) when the fix ships
- A coordinated disclosure window — typically 90 days from initial report, shorter for actively-exploited issues

### What we ask from you

- Give us a reasonable window to fix the issue before public disclosure (we suggest 90 days, but we'll talk if there's a specific reason for urgency)
- Do not exploit the vulnerability beyond what's necessary to demonstrate it
- Do not test on deployments you don't own — running a vulnerability test against someone else's Sovereign Portal deployment is not authorized by this policy and may be illegal
- Do not access, modify, or delete data belonging to others

---

## Supported versions

Sovereign Portal is pre-1.0. Security fixes are backported to the most recent minor release only.

| Version | Status |
|---|---|
| v0.x latest | ✅ Supported |
| v0.x older | ❌ Not supported — upgrade |

Once we ship 1.0, this table will document the LTS policy.

---

## Scope

The following are in scope for security disclosure:

- The framework core (`@sovereign-portal/core`)
- The Users module (auth, sessions, invites, role catalogs)
- The Customers and Workspaces modules
- The reference Twilio OTP auth adapter
- `portal-shell` (the host application)
- The conformance suite CLI

The following are **out of scope**:

- Vulnerabilities in your specific deployment's configuration, custom modules, or theming
- Vulnerabilities in third-party identity providers (report to them directly)
- Vulnerabilities in modules you or others have built on top of the framework
- Issues in deployments running modified versions of the framework — we cannot vouch for forks

If you're not sure whether something is in scope, email anyway. We'd rather receive an out-of-scope report than miss a real issue because someone hesitated.

---

## Commercial security support

For deployments running Sovereign Portal in regulated industries (healthcare, finance, government) or with compliance requirements that need SLA-bound vulnerability response, Freshify offers commercial security support as part of the [Advantage Retainer](SUPPORT.md). This includes:

- 24-hour acknowledgement window (vs. 2 business days for community reports)
- Priority remediation for issues affecting your deployment specifically
- Pre-disclosure notification of advisories so you can patch before public release
- Optional security review of your custom modules against the SMI security model

Email **security@freshify.io** to discuss.

---

## Past advisories

Security advisories are published at https://github.com/sovereign-portal/sovereign-portal/security/advisories once fixes are available.

---

*The security of Sovereign Portal deployments depends on responsible disclosure. Thank you for taking the time to report what you find.*
