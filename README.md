# Dork Mail

A self-hosted email server for people who thought "how hard could it really be."

Built on AWS SES, DynamoDB, and Lambda — fully serverless, no VMs, no mail transfer agents, no 3AM postfix debugging.

**Why "Dork Mail"?** Because only a dork responds to a deprecation notice by building their own mail server. We are those dorks.

---

## What it does

- **Receives email** via SES receipt rules → stores raw `.eml` in S3 → parses and indexes into DynamoDB
- **Sends email** via SES with full DKIM signing
- **Web UI** — dark mode, Gmail-ish layout: inbox, compose, reply, attachments, labels, trash
- **Setup wizard** — reads your Route 53 zone, identifies missing/incorrect DNS records (MX, SPF, DKIM, DMARC), and writes fixes with one click; manages SES verified emails for sandbox testing; submits production access requests
- **Multi-user** — multiple mailboxes on a single domain, admin-controlled user management panel
- **Account settings** — users can update their display name and change their own password
- **JWT auth** — simple, stateless, no Cognito

---

## Architecture

```mermaid
flowchart TD
    subgraph Inbound["Inbound Mail"]
        SES_IN[SES Receipt Rule]
        S3_EMAIL[(S3\nraw .eml)]
        INGEST[email-ingest\nLambda]
    end

    subgraph Storage["Storage"]
        DYNAMO[(DynamoDB\nsingle table)]
    end

    subgraph Frontend["Frontend"]
        CF[CloudFront]
        S3_WEB[(S3\nweb assets)]
        BROWSER[Browser]
    end

    subgraph API["API Layer"]
        APIGW[API Gateway v2]
        AUTHZ[authorizer Lambda\nJWT → SSM]
        API_AUTH[api Lambda\nauth]
        API_MAIL[api Lambda\nmail]
        API_DNS[api Lambda\ndns / setup]
    end

    subgraph Outbound["Outbound Mail"]
        SES_OUT[SES Send]
    end

    SES_IN -->|S3 Put| S3_EMAIL
    S3_EMAIL -->|trigger| INGEST
    INGEST -->|PutItem| DYNAMO

    BROWSER -->|HTTPS| CF
    CF -->|OAC| S3_WEB
    CF -->|/api/*| APIGW

    APIGW --> AUTHZ
    AUTHZ -->|verify| SSM[(SSM\nJWT secret)]
    APIGW --> API_AUTH
    APIGW --> API_MAIL
    APIGW --> API_DNS

    API_AUTH <-->|users| DYNAMO
    API_MAIL <-->|email index| DYNAMO
    API_MAIL -->|send| SES_OUT
    API_MAIL -->|presigned URL| S3_EMAIL
    API_DNS <-->|records| R53[(Route 53)]
    API_DNS <-->|domain status| SES_IN
```

All AWS SDK calls use **IAM execution roles** — no access keys in any application code.

### AWS services used

| Service | Purpose |
|---|---|
| SES | Receive and send email |
| S3 | Raw `.eml` storage, web static assets |
| DynamoDB | Email index, user accounts |
| Lambda | Email ingestion, API handlers, JWT authorizer |
| API Gateway v2 | HTTP API for the web app |
| CloudFront | CDN for the web app, `/api` proxy |
| Route 53 | DNS management (zone must exist) |
| ACM | TLS certificate for the web subdomain |
| SSM Parameter Store | JWT secret (SecureString) |
| X-Ray | Distributed tracing via Powertools |

---

## Repository layout

```
dork-mail/
├── terraform/              # All AWS infrastructure — intended for use as a module
├── functions/              # Lambda functions (TypeScript + AWS Powertools)
│   └── src/
│       ├── email-ingest/   # S3 trigger: raw email → DynamoDB
│       ├── authorizer/     # JWT Lambda authorizer for API Gateway
│       └── api/
│           ├── auth.ts     # Login, user CRUD (admin + self-service)
│           ├── mail.ts     # List, read, send, update, delete, attachments
│           └── dns.ts      # DNS check/apply, SES status, sandbox management
├── web/                    # SvelteKit frontend (dark mode)
│   └── src/routes/
│       ├── login/
│       ├── mail/           # Inbox, message view
│       │   ├── [messageId]/    # Single message view
│       │   ├── compose/        # Compose / reply
│       │   ├── account/        # Account settings (display name, password)
│       │   └── admin/users/    # Admin user management panel
│       └── setup/          # DNS wizard
├── shared/                 # Shared TypeScript types
├── scripts/
│   ├── deploy-functions.ts     # Deploy Lambda code via update-function-code
│   ├── deploy-web.ts           # S3 sync + CloudFront invalidation for the web app
│   ├── init-deploy-config.ts   # Write deploy.json from terraform output
│   └── gen-password-hash.mjs   # Generate bcrypt hash for admin password
├── deploy.example.json     # Example deploy.json (the real one is gitignored)
└── deploy.json             # Your deploy config — gitignored, generated from terraform output
```

---

## Prerequisites

- An AWS account
- A domain with a Route 53 hosted zone already set up (Terraform handles the email DNS records — the zone just needs to exist)
- AWS CLI configured with credentials **for the person running Terraform** (this is the only place credentials are needed)
- Node.js 22+
- pnpm
- Terraform 1.7+

SES email receiving is only available in `us-east-1`, `us-west-2`, and `eu-west-1`. Pick one.

---

## Deployment

The `terraform/` directory is designed to be used as a **module** from your own Terraform root — not applied in-place. This keeps your secrets and state management separate from this repo.

### 1. Install dependencies

```sh
pnpm install
```

### 2. Add dork-mail to your Terraform root

In your own Terraform configuration:

```hcl
module "dork_mail" {
  source = "github.com/you/dork-mail//terraform?ref=main"

  domain              = "yourdomain.com"
  jwt_secret          = var.jwt_secret          # openssl rand -base64 48
  admin_email         = "you@yourdomain.com"
  admin_password_hash = var.admin_password_hash  # pnpm gen-password-hash
  admin_display_name  = "Your Name"
}

# Re-export the deploy config so the deploy scripts can read it
output "deploy_config" {
  value = module.dork_mail.deploy_config
}

output "web_url" {
  value = module.dork_mail.web_url
}
```

Generate the admin password hash before applying:

```sh
pnpm gen-password-hash
```

### 3. Apply infrastructure

```sh
cd your-terraform-root
terraform init
terraform apply
```

This creates all AWS resources, writes DNS records to your Route 53 zone, provisions the CloudFront distribution at `mail.yourdomain.com`, and stores the JWT secret in SSM.

### 4. Write deploy.json

```sh
cd your-terraform-root
terraform output -raw deploy_config > /path/to/dork-mail/deploy.json
```

Or from inside this repo if your Terraform root is elsewhere:

```sh
pnpm deploy:all:init --tf-dir /path/to/your-terraform-root
```

This is a one-time step. `deploy.json` is gitignored — see `deploy.example.json` for its shape.

### 5. Build and deploy

```sh
pnpm build
pnpm deploy:all
```

`pnpm build` compiles the Lambda functions and the web app. `pnpm deploy:all` pushes the Lambda zips via `update-function-code` and syncs the web app to S3, then invalidates CloudFront.

### 6. Done

Open `https://mail.yourdomain.com`, log in with your admin credentials, and you'll land on the DNS wizard. If Terraform already wrote your DNS records they should show green — if anything is yellow or red, click **Apply all fixes**.

---

## Exiting the SES sandbox

New AWS accounts are in SES sandbox mode — you can only send mail to email addresses you've manually verified. To send to anyone:

1. In the setup wizard, use **Verified Emails** to add test addresses while in sandbox mode
2. When ready, click **Request production access** in the wizard (or go to AWS Console → **SES → Account Dashboard** → **Request production access**)
3. Select **Transactional** mail type
4. Describe your use case (self-hosted mail server for your own domain)
5. AWS typically approves within 24–48 hours

The setup wizard walks through all of this with live status indicators.

---

## Module reference

### Inputs

| Variable | Required | Default | Description |
|---|---|---|---|
| `domain` | yes | — | Mail domain, e.g. `example.com` |
| `jwt_secret` | yes | — | JWT signing secret (stored in SSM SecureString) |
| `admin_email` | yes | — | Initial admin user email |
| `admin_password_hash` | yes | — | bcrypt hash of admin password |
| `admin_display_name` | no | `Admin` | Display name for admin user |
| `web_subdomain` | no | `mail` | Subdomain prefix for the UI |
| `aws_region` | no | `us-east-1` | Deployment region |
| `ses_rule_set_name` | no | `dork-mail` | SES receipt rule set name |
| `tags` | no | `{}` | Tags applied to all resources |

### Outputs

| Output | Description |
|---|---|
| `deploy_config` | JSON blob consumed by the deploy scripts. Pipe to `deploy.json` after apply. |
| `web_url` | URL of the web UI |
| `ses_verification_status` | Helper command to check SES domain verification status |

---

## Ongoing operations

### Redeploying after code changes

```sh
pnpm build
pnpm deploy:all
```

No `terraform apply` needed for code-only changes — Terraform ignores function code after initial creation.

To redeploy just one layer:

```sh
pnpm deploy:all:functions   # Lambda only
pnpm deploy:all:web         # S3 + CloudFront only
```

### Adding or managing users

Log in as admin and go to **Admin → Users** in the sidebar. Or via API:

```sh
curl -X POST https://mail.yourdomain.com/api/auth/users \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"newuser@yourdomain.com","password":"...","displayName":"New User"}'
```

Passwords must be at least 12 characters and include an uppercase letter, a digit, and a special character.

### Account settings

Any user can update their display name and change their own password from the **Account** page in the sidebar.

---

## Cost

Rough estimate for light personal use (~1,000 emails/month, one user):

| Service | ~Monthly cost |
|---|---|
| SES receiving | $0.10 per 1,000 emails = **$0.10** |
| SES sending | $0.10 per 1,000 emails = **$0.10** |
| S3 (raw emails + web) | < **$0.10** |
| DynamoDB (PAY_PER_REQUEST) | < **$0.10** |
| Lambda invocations | < **$0.01** |
| API Gateway | < **$0.01** |
| CloudFront | < **$0.10** |
| **Total** | **~$0.50/month** |

The ACM certificate and Route 53 record changes are free. You'll pay for the hosted zone itself (~$0.50/month) if you don't already have one.

---

## Local development

```sh
# Start the web dev server (proxies /api to localhost:3001)
pnpm dev

# The functions don't have a local runtime yet — point VITE_API_URL at a
# deployed API Gateway endpoint for now, or use SAM/LocalStack if you want
# to run Lambda locally.
export VITE_API_URL=https://your-api-gateway-id.execute-api.us-east-1.amazonaws.com
pnpm dev
```

---

## Security notes

- **No access keys in app code** — all AWS SDK calls use Lambda execution roles
- **JWT secret** stored in SSM Parameter Store as a SecureString, never in environment variables as plaintext
- **S3 buckets** are fully private — web assets served only via CloudFront OAC, emails accessible only to Lambda roles
- **Email HTML** is rendered in a sandboxed `<iframe>` with `sandbox="allow-same-origin"` to prevent script execution
- **Attachment downloads** use short-lived (5 minute) S3 presigned URLs — no attachment bytes flow through Lambda
- **User enumeration** is prevented — login returns the same error for unknown user and wrong password
- **Password strength** enforced server-side: minimum 12 characters, must include uppercase, digit, and special character
- SES **TLS required** for all outbound sending (configured in the SES configuration set)

---

## License

Do whatever you want with it. If you make it better, consider sharing.
