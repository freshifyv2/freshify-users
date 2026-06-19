# freshify-users

Backend service for the **Users** sovereign module of [Sovereign Portal](https://github.com/freshifyv2/freshify-sovereign-portal).

The Users module owns identity end-to-end: signup, login, password reset, invite acceptance, sessions, role catalogs, and the membership / tenant model that powers the portal tenant switcher.

Auth is a pluggable adapter contract. This service ships the **email + password** reference adapter and a **Twilio OTP** adapter, both behind the same interface. Customers can swap in Auth0, Okta, Cognito, Clerk, or any identity provider against the same contract.

## Role in the foundation

| Surface | What this service exposes |
|---|---|
| HTTP | `/v1/auth/*` (register, verify-email, login, request-reset, reset-password), `/v1/users/*`, `/v1/memberships/*`, `/v1/admin/*` |
| SMI | `moduleRegistry`, peer registry, role catalog, capability list |
| Events | `user.registered`, `user.verified`, `user.invited`, `membership.changed` |
| Owned collections | `users`, `user_credentials`, `user_verifications`, `password_resets`, `sessions`, `memberships` |

Frontend counterpart: [`freshify-users-fe`](https://github.com/freshifyv2/freshify-users-fe). Pre-auth screens (login, signup, reset) are owned by the [portal shell](https://github.com/freshifyv2/freshify-portal-shell).

## Run locally

```bash
npm install
cp .env.example .env  # set MONGODB_URI, JWT_SECRET, COMMS_URL, etc.
npm run dev
```

Defaults to `http://localhost:8080`. The first boot bootstraps the Module Admin operator and prints the verification link to the logs.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | HS256 signing secret for user sessions |
| `INTERNAL_S2S_SECRET` | yes | Shared secret for peer-to-peer SMI calls between sovereign modules |
| `COMMS_SHARED_SECRET` | yes | Shared secret for calls into `freshify-comms` |
| `COMMS_URL` | yes | `freshify-comms` URL for sending verification + reset emails |
| `COMPANIES_SERVICE_URL` | yes | `freshify-companies` base URL |
| `WORKSPACES_SERVICE_URL` | yes | `freshify-workspaces` base URL |
| `PORTAL_PUBLIC_URL` | yes | Public URL of the portal shell, used in verification + reset links |
| `TWILIO_*` | no | Account SID / Auth Token / Verify Service SID. When unset, OTP falls back to a console-log adapter (dev only). |
| `PORT` | no | Defaults to `8080` |

## Conformance

This service conforms to the [Standard Module Interface](https://github.com/freshifyv2/freshify-sovereign-portal/blob/main/docs/smi-spec.md). Run the conformance suite against this repo with:

```bash
npx sovereign-portal verify .
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Copyright 2026 Freshify, Inc.

## Support

- Bugs and feature requests: open an issue. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first.
- Security disclosures: see [SECURITY.md](./SECURITY.md). Do not open a public issue.
- Production deployment, custom modules, architecture review: see [SUPPORT.md](./SUPPORT.md).
