# JWT secret — SecureString so it's encrypted at rest and never in Lambda env vars as plaintext
resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${local.name_prefix}/jwt-secret"
  type        = "SecureString"
  value       = var.jwt_secret
  description = "JWT signing secret for Dork Mail"
}

locals {
  push_enabled    = var.vapid_public_key != "" && var.vapid_private_key != ""
  vapid_param     = "/${local.name_prefix}/vapid-keys"
  vapid_param_arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.vapid_param}"
}

resource "aws_ssm_parameter" "vapid_keys" {
  count       = local.push_enabled ? 1 : 0
  name        = local.vapid_param
  type        = "SecureString"
  value       = jsonencode({ publicKey = var.vapid_public_key, privateKey = var.vapid_private_key })
  description = "Web Push VAPID key pair for Dork Mail"
}
