
# Stepaway Queue — Phase 1 (Core Token Issuing)

MVP implementing:

- QR Landing Page / Customer UI → Static site in S3 + CloudFront (`web/`)
- API Layer → Amazon API Gateway (HTTP)
- Business Logic → AWS Lambda (Node.js 20 / TypeScript) (`services/api`)
- Queue Data Store → Amazon DynamoDB (single table PK/SK) (`QueueTable` via CDK)
- Auth (staff-only) → Amazon Cognito User Pool
- Infra as Code → AWS CDK (TypeScript) (`infra/`)

## Monorepo layout

- `infra/` — AWS CDK app with split stacks for separate deploys:
  - `Stepaway-BaseInfra` (DynamoDB, Cognito, S3+CloudFront)
  - `Stepaway-Api` (Lambda + HTTP API)
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

3) Synthesize and deploy stacks separately:

```
# Build TS -> JS (required since CDK runs compiled output)
npm -w infra run build

# Synth either stack
npm -w infra run cdk:synth:base
npm -w infra run cdk:synth:api

# Deploy separately (BaseInfra first, then Api)
npm -w infra run cdk:deploy:base
npm -w infra run cdk:deploy:api
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
- CDK synth base: `npm -w infra run cdk:synth:base`
- CDK synth api: `npm -w infra run cdk:synth:api`
- CDK deploy base: `npm -w infra run cdk:deploy:base`
- CDK deploy api: `npm -w infra run cdk:deploy:api`
- Build API: `npm -w services/api run build`

## CI/CD (GitHub Actions)

Two workflows are included:

- `.github/workflows/deploy-base.yml` — builds and deploys `Stepaway-BaseInfra` when `infra/` or `web/` changes.
- `.github/workflows/deploy-api.yml` — builds and deploys `Stepaway-Api` when `infra/` or `services/api/` changes.

Both use GitHub OIDC to assume the role `arn:aws:iam::967438331002:role/bookclub-app-role` in region `ap-southeast-2`.

Ensure that IAM role trusts GitHub OIDC and allows `sts:AssumeRole` for your repository. Minimal trust policy (example):

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::967438331002:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:pedaganim/stepaway-queue:*"
        }
      }
    }
  ]
}
```

Attach permissions to allow CDK deploys (often AdministratorAccess in a dev account; or a least-privilege policy that covers CloudFormation, IAM, S3, CloudFront, DynamoDB, Lambda, API Gateway v2, Cognito, SSM). CDK will also require bootstrap resources in the target account/region.

To run bootstrap via CI, dispatch `deploy-base.yml` once (the job will run `npx cdk deploy` which will create missing bootstrap resources if necessary) or run locally with your AWS profile.

## Next steps

- Implement `/enqueue` to create a ticket item in DynamoDB.
- Add staff console (could be another static site or protected route) leveraging Cognito.
- Define item keys: e.g., `PK=LOC#<locationId>` and `SK=TKT#<ticketId>`, plus GSIs for service/status queries.
- Add CI/CD and environment parameterization.

First commit