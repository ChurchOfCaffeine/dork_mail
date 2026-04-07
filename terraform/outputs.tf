output "deploy_config" {
  description = "Deploy configuration for the scripts in this repo. Run: terraform output -raw deploy_config > deploy.json"
  value = jsonencode({
    region = var.aws_region
    functions = {
      "email-ingest" = aws_lambda_function.email_ingest.function_name
      "authorizer"   = aws_lambda_function.authorizer.function_name
      "api-auth"     = aws_lambda_function.api_auth.function_name
      "api-mail"     = aws_lambda_function.api_mail.function_name
      "api-dns"      = aws_lambda_function.api_dns.function_name
    }
    web_bucket              = aws_s3_bucket.web.id
    cloudfront_distribution = aws_cloudfront_distribution.web.id
  })
}

output "web_url" {
  description = "URL of the Dork Mail web interface"
  value       = "https://${local.web_fqdn}"
}

output "ses_verification_status" {
  description = "Whether SES domain identity is verified (check after apply)"
  value       = "Run: aws ses get-identity-verification-attributes --identities ${var.domain} --region ${var.aws_region}"
}

