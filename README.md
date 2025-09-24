
# Stepaway Queue — Phase 1 (Core Token Issuing)

MVP implementing:

- QR Landing Page / Customer UI → Static site in S3 + CloudFront (`web/`)
- API Layer → Amazon API Gateway (HTTP)
- Business Logic → AWS Lambda (Node.js 20 / TypeScript) (`services/api`)
- Queue Data Store → Amazon DynamoDB (single table PK/SK) (`QueueTable` via CDK)
- Auth (staff-only) → Amazon Cognito User Pool
- Infra as Code → AWS CDK (TypeScript) (`infra/`)

## Monorepo layout

- `infra/` — AWS CDK app and stack (`StepawayInfraStack`) provisioning DynamoDB, Lambda, HTTP API, Cognito, S3+CloudFront.
- `services/api/` — Lambda handler (TypeScript) with a basic router and `/health` check.
- `web/` — Static landing page placeholder. Discover API via `?api=...` URL param or `localStorage.STEP_API`.

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials and default region (e.g. `ap-southeast-2`)
- CDK bootstrap in your target AWS account/region

## Quick start

1) Install dependencies (root workspaces):

```
npm install --workspaces
```

2) Bootstrap CDK (per account/region; run once):

```
npm -w infra run cdk:bootstrap
```

3) Synthesize and deploy all stacks:

```
npm -w infra run cdk:synth
npm -w infra run cdk:deploy
```

Outputs will include:

- `ApiUrl` — base URL of the HTTP API
- `SiteUrl` — CloudFront distribution domain (serving `web/`)
- `UserPoolId` and `UserPoolClientId` — Cognito identifiers

4) Test the site and API

- Health check: `${ApiUrl}/health`
- Open the static site: `https://<SiteUrl>/` and pass the API base via query param, for example:
  - `https://<SiteUrl>/?api=${ApiUrl}`
  - Or set permanently in dev: `localStorage.setItem('STEP_API', ApiUrl)`

## Development notes

- DynamoDB is single-table, on-demand billing, with `PK`/`SK` attributes. The specific ticket/item schema will be added in the next iterations.
- `services/api/src/index.ts` currently returns a placeholder response and supports `/health`. Add routes for `/enqueue`, `/next`, etc.
- CORS is open for MVP; tighten for production.
- Buckets and Cognito are set with `RemovalPolicy.DESTROY` for iteration speed. Change to `RETAIN` before production.

## Useful commands

- Build infra: `npm -w infra run build`
- CDK synth: `npm -w infra run cdk:synth`
- CDK deploy: `npm -w infra run cdk:deploy`
- Build API: `npm -w services/api run build`

## Next steps

- Implement `/enqueue` to create a ticket item in DynamoDB.
- Add staff console (could be another static site or protected route) leveraging Cognito.
- Define item keys: e.g., `PK=LOC#<locationId>` and `SK=TKT#<ticketId>`, plus GSIs for service/status queries.
- Add CI/CD and environment parameterization.

First commit