output "web_url" {
  description = "URL of the Dork Mail web interface"
  value       = "https://${local.web_fqdn}"
}

output "api_endpoint" {
  description = "API Gateway endpoint (proxied through CloudFront at /api)"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "email_bucket" {
  description = "S3 bucket storing raw incoming emails"
  value       = aws_s3_bucket.emails.id
}

output "dynamo_table" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.main.name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — needed for cache invalidation on deploy"
  value       = aws_cloudfront_distribution.web.id
}

output "ses_verification_status" {
  description = "Whether SES domain identity is verified (check after apply)"
  value       = "Run: aws ses get-identity-verification-attributes --identities ${var.domain} --region ${var.aws_region}"
}

