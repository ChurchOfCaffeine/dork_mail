# Terraform manages Lambda configuration (roles, env vars, triggers).
# Code is deployed separately via scripts/deploy-functions.ts, which calls
# update-function-code directly. Terraform never touches code after the
# initial stub is created.
#
# Tracing is PassThrough rather than omitted, since removing the block keeps
# whatever mode the function already has. Nothing upstream sends a sampled
# trace header, so no traces are recorded.

locals {
  lambda_runtime = "nodejs24.x"

  lambda_env_common = {
    TABLE_NAME              = aws_dynamodb_table.main.name
    EMAIL_BUCKET            = aws_s3_bucket.emails.id
    MAIL_DOMAIN             = var.domain
    HOSTED_ZONE_ID          = local.hosted_zone_id
    SES_INBOUND_EP          = local.ses_inbound_ep
    JWT_SECRET_PARAM        = aws_ssm_parameter.jwt_secret.name
    SES_CONFIG_SET          = aws_ses_configuration_set.main.name
    WEB_ORIGIN              = "https://${local.web_fqdn}"
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
  timeout          = 120
  # mailparser holds the raw message and every decoded part in memory, and SES accepts messages up to 40 MB.
  memory_size = 1024

  tracing_config { mode = "PassThrough" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# SES invokes ingest asynchronously. Events that still fail after Lambda's
# retries land here instead of being dropped; see "Failed deliveries" in the README.
resource "aws_sqs_queue" "email_ingest_failed" {
  name                      = "${local.name_prefix}-email-ingest-failed"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_function_event_invoke_config" "email_ingest" {
  function_name = aws_lambda_function.email_ingest.function_name

  destination_config {
    on_failure {
      destination = aws_sqs_queue.email_ingest_failed.arn
    }
  }
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "email_ingest_failed" {
  alarm_name          = "${local.name_prefix}-email-ingest-failed"
  alarm_description   = "Inbound mail failed to ingest and is waiting in the ${aws_sqs_queue.email_ingest_failed.name} queue. Check the email-ingest logs, fix the cause, then redrive the queued events as described in the README."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.email_ingest_failed.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Invoked by the receipt rule in ses.tf, which carries the envelope recipients
# and spam verdicts that an S3 put notification doesn't.
resource "aws_lambda_permission" "email_ingest_ses" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.email_ingest.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
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

  tracing_config { mode = "PassThrough" }
  environment {
    variables = {
      JWT_SECRET_PARAM        = aws_ssm_parameter.jwt_secret.name
      TABLE_NAME              = aws_dynamodb_table.main.name
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
  role             = aws_iam_role.api["auth"].arn
  runtime          = local.lambda_runtime
  handler          = "auth.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  # API Gateway gives up at 30 s; deleting a user with a lot of mail needs most of it.
  timeout     = 29
  memory_size = 256

  tracing_config { mode = "PassThrough" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ─── API: JMAP ────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "api_jmap" {
  function_name    = "${local.name_prefix}-api-jmap"
  role             = aws_iam_role.api["jmap"].arn
  runtime          = local.lambda_runtime
  handler          = "jmap.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 29
  memory_size      = 512

  tracing_config { mode = "PassThrough" }
  environment { variables = local.lambda_env_common }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ─── API: DNS Wizard ──────────────────────────────────────────────────────────

resource "aws_lambda_function" "api_dns" {
  function_name    = "${local.name_prefix}-api-dns"
  role             = aws_iam_role.api["dns"].arn
  runtime          = local.lambda_runtime
  handler          = "dns.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256
  timeout          = 30
  memory_size      = 256

  tracing_config { mode = "PassThrough" }
  environment {
    variables = merge(local.lambda_env_common, {
      SES_INBOUND_ENDPOINT = local.ses_inbound_ep
      DMARC_REPORT_EMAIL   = var.dmarc_report_email
    })
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
