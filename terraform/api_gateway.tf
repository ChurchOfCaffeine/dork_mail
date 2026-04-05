# HTTP API (API Gateway v2) — lower cost and latency than REST API for this use case

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://${local.web_fqdn}"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "prod" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "api_gw" {
  name              = "/aws/apigateway/${local.name_prefix}"
  retention_in_days = 14
}

# ─── JWT Authorizer ───────────────────────────────────────────────────────────

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_function.authorizer.invoke_arn
  identity_sources = ["$request.header.Authorization"]
  name             = "jwt"

  authorizer_payload_format_version = "1.0"
  enable_simple_responses           = false
  authorizer_result_ttl_in_seconds  = 300
}

resource "aws_lambda_permission" "authorizer_apigw" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ─── Integrations ─────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "auth" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api_auth.invoke_arn
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_integration" "mail" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api_mail.invoke_arn
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_integration" "dns" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api_dns.invoke_arn
  payload_format_version = "1.0"
}

# Lambda invoke permissions for API Gateway
resource "aws_lambda_permission" "api_auth" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_mail" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_mail.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_dns" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_dns.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ─── Routes ───────────────────────────────────────────────────────────────────

# Public (no auth)
resource "aws_apigatewayv2_route" "post_login" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/auth/login"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

# Protected routes
locals {
  protected_routes = {
    "GET /api/auth/users"                            = aws_apigatewayv2_integration.auth.id
    "POST /api/auth/users"                           = aws_apigatewayv2_integration.auth.id
    "PATCH /api/auth/users/{email}"                  = aws_apigatewayv2_integration.auth.id
    "DELETE /api/auth/users/{email}"                 = aws_apigatewayv2_integration.auth.id
    "GET /api/mail"                                  = aws_apigatewayv2_integration.mail.id
    "GET /api/mail/{messageId}"                      = aws_apigatewayv2_integration.mail.id
    "POST /api/mail/send"                            = aws_apigatewayv2_integration.mail.id
    "PATCH /api/mail/{messageId}"                    = aws_apigatewayv2_integration.mail.id
    "DELETE /api/mail/{messageId}"                   = aws_apigatewayv2_integration.mail.id
    "GET /api/mail/{messageId}/attachment/{proxy+}"  = aws_apigatewayv2_integration.mail.id
    "GET /api/dns/check"                             = aws_apigatewayv2_integration.dns.id
    "POST /api/dns/apply"                            = aws_apigatewayv2_integration.dns.id
    "GET /api/dns/ses-status"                        = aws_apigatewayv2_integration.dns.id
    "POST /api/dns/ses-verify"                       = aws_apigatewayv2_integration.dns.id
    "GET /api/dns/verified-emails"                   = aws_apigatewayv2_integration.dns.id
    "POST /api/dns/verified-emails"                  = aws_apigatewayv2_integration.dns.id
    "DELETE /api/dns/verified-emails/{email}"        = aws_apigatewayv2_integration.dns.id
    "POST /api/dns/request-production-access"        = aws_apigatewayv2_integration.dns.id
  }
}

resource "aws_apigatewayv2_route" "protected" {
  for_each = local.protected_routes

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.key
  target             = "integrations/${each.value}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}
