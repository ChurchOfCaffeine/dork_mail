# Terraform manages Lambda configuration (roles, env vars, triggers).
# Code is deployed separately via scripts/publish-lambdas.sh, which calls
# aws lambda update-function-code directly — Terraform never touches code after
# the initial stub is created.

locals {
  lambda_runtime = "nodejs24.x"

  lambda_env_common = {
    TABLE_NAME              = aws_dynamodb_table.main.name
    EMAIL_BUCKET            = aws_s3_bucket.emails.id
    MAIL_DOMAIN             = var.domain
    HOSTED_ZONE_ID          = local.hosted_zone_id
    SES_INBOUND_EP          = local.ses_inbound_ep
    JWT_SECRET_PARAM        = aws_ssm_parameter.jwt_secret.name
    POWERTOOLS_SERVICE_NAME = "dork-mail"
    LOG_LEVEL               = "INFO"
  }
}

# ─── Stub zip ─────────────────────────────────────────────────────────────────
# A minimal valid Lambda handler used only for initial resource creation.
# The publish script overwrites the real code without involving Terraform.

data "archive_file" "stub" {
  type = "zip"
  source {
    content  = "exports.handler = async () => ({ statusCode: 202, body: 'deploying' });"
    filename = "handler.js"
  }
  output_path = "${path.module}/stub.zip"
}

# ─── Email Ingest ─────────────────────────────────────────────────────────────

resource "aws_lambda_function" "email_ingest" {
  function_name    = "${local.name_prefix}-email-ingest"
  role             = aws_iam_role.email_ingest.arn
  runtime          = local.lambda_runtime
  handler          = "handler.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 30
  memory_size      = 256

  tracing_config { mode = "Active" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_permission" "email_ingest_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.email_ingest.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.emails.arn
}

resource "aws_s3_bucket_notification" "email_ingest" {
  bucket = aws_s3_bucket.emails.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.email_ingest.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
  }
  depends_on = [aws_lambda_permission.email_ingest_s3]
}

# ─── Authorizer ───────────────────────────────────────────────────────────────

resource "aws_lambda_function" "authorizer" {
  function_name    = "${local.name_prefix}-authorizer"
  role             = aws_iam_role.authorizer.arn
  runtime          = local.lambda_runtime
  handler          = "handler.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 5
  memory_size      = 128

  tracing_config { mode = "Active" }
  environment {
    variables = {
      JWT_SECRET_PARAM        = aws_ssm_parameter.jwt_secret.name
      POWERTOOLS_SERVICE_NAME = "dork-mail-authorizer"
      LOG_LEVEL               = "INFO"
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ─── API: Auth ────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "api_auth" {
  function_name    = "${local.name_prefix}-api-auth"
  role             = aws_iam_role.api.arn
  runtime          = local.lambda_runtime
  handler          = "auth.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 15
  memory_size      = 256

  tracing_config { mode = "Active" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ─── API: Mail ────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "api_mail" {
  function_name    = "${local.name_prefix}-api-mail"
  role             = aws_iam_role.api.arn
  runtime          = local.lambda_runtime
  handler          = "mail.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 15
  memory_size      = 256

  tracing_config { mode = "Active" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ─── API: DNS Wizard ──────────────────────────────────────────────────────────

resource "aws_lambda_function" "api_dns" {
  function_name    = "${local.name_prefix}-api-dns"
  role             = aws_iam_role.api.arn
  runtime          = local.lambda_runtime
  handler          = "dns.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 30
  memory_size      = 256

  tracing_config { mode = "Active" }
  environment {
    variables = merge(local.lambda_env_common, {
      SES_INBOUND_ENDPOINT = local.ses_inbound_ep
    })
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
