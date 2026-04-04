# JWT secret — SecureString so it's encrypted at rest and never in Lambda env vars as plaintext
resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${local.name_prefix}/jwt-secret"
  type        = "SecureString"
  value       = var.jwt_secret
  description = "JWT signing secret for Dork Mail"
}
