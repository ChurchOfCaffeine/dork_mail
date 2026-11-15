# ─── Common assume-role policy for Lambda ─────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ─── Email Ingest Lambda role ─────────────────────────────────────────────────

resource "aws_iam_role" "email_ingest" {
  name               = "${local.name_prefix}-email-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "email_ingest_basic" {
  role       = aws_iam_role.email_ingest.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "email_ingest_inline" {
  name = "email-ingest-perms"
  role = aws_iam_role.email_ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadEmailBucket"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.emails.arn}/incoming/*"
      },
      {
        Sid    = "WriteParsedParts"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.emails.arn}/attachments/*",
          "${aws_s3_bucket.emails.arn}/bodies/*",
        ]
      },
      {
        Sid    = "EmailTable"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:DeleteItem",
        ]
        Resource = [
          aws_dynamodb_table.main.arn,
          "${aws_dynamodb_table.main.arn}/index/*",
        ]
      },
      {
        Sid      = "FailedEventQueue"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.email_ingest_failed.arn
      }
    ]
  })
}

# ─── Authorizer Lambda role ───────────────────────────────────────────────────

resource "aws_iam_role" "authorizer" {
  name               = "${local.name_prefix}-authorizer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "authorizer_basic" {
  role       = aws_iam_role.authorizer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "authorizer_inline" {
  name = "authorizer-perms"
  role = aws_iam_role.authorizer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadJwtSecret"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.jwt_secret.arn
      },
      {
        Sid      = "ReadUsers"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.main.arn
      }
    ]
  })
}

# ─── API Lambda roles, one per handler ───────────────────────────────────────

resource "aws_iam_role" "api" {
  for_each           = toset(["auth", "jmap", "dns"])
  name               = "${local.name_prefix}-api-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_basic" {
  for_each   = aws_iam_role.api
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api_auth" {
  name = "api-auth-perms"
  role = aws_iam_role.api["auth"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.main.arn,
          "${aws_dynamodb_table.main.arn}/index/*",
        ]
      },
      {
        Sid      = "S3ListAccountObjects"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.emails.arn
      },
      {
        Sid    = "S3DeleteAccountObjects"
        Effect = "Allow"
        Action = ["s3:DeleteObject"]
        Resource = [
          "${aws_s3_bucket.emails.arn}/raw/*",
          "${aws_s3_bucket.emails.arn}/bodies/*",
          "${aws_s3_bucket.emails.arn}/attachments/*",
          "${aws_s3_bucket.emails.arn}/uploads/*",
        ]
      },
      {
        Sid      = "SSM"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.jwt_secret.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "api_jmap" {
  name = "api-jmap-perms"
  role = aws_iam_role.api["jmap"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.main.arn,
          "${aws_dynamodb_table.main.arn}/index/*",
        ]
      },
      {
        Sid      = "S3EmailRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.emails.arn}/*"
      },
      {
        Sid    = "S3EmailWrite"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.emails.arn}/attachments/*",
          "${aws_s3_bucket.emails.arn}/bodies/*",
          "${aws_s3_bucket.emails.arn}/raw/*",
        ]
      },
      {
        Sid      = "S3BodyDelete"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = "${aws_s3_bucket.emails.arn}/bodies/*"
      },
      {
        Sid    = "SES"
        Effect = "Allow"
        Action = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = [
          "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
          aws_ses_configuration_set.main.arn,
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "api_dns" {
  name = "api-dns-perms"
  role = aws_iam_role.api["dns"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SESRead"
        Effect = "Allow"
        Action = [
          "ses:GetIdentityVerificationAttributes",
          "ses:GetIdentityDkimAttributes",
          "ses:GetSendQuota",
          "ses:VerifyDomainIdentity",
          "ses:VerifyDomainDkim",
          "ses:VerifyEmailIdentity",
          "ses:ListIdentities",
          "ses:DeleteIdentity",
          "ses:GetAccount",
          "ses:PutAccountDetails",
        ]
        Resource = "*"
      },
      {
        Sid    = "Route53Read"
        Effect = "Allow"
        Action = [
          "route53:ListResourceRecordSets",
          "route53:ChangeResourceRecordSets",
        ]
        Resource = "arn:aws:route53:::hostedzone/${local.hosted_zone_id}"
      }
    ]
  })
}
