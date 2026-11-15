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
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  # Caps what password guessing costs in bcrypt Lambda time. The limit is shared by all
  # callers, so a flood delays real sign-ins; the per-account lockout in auth.ts stops guessing.
  dynamic "route_settings" {
    for_each = toset(["POST /api/auth", "POST /api/auth/login"])
    content {
      route_key              = route_settings.value
      throttling_rate_limit  = 5
      throttling_burst_limit = 10
    }
  }

  depends_on = [aws_apigatewayv2_route.public]
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

resource "aws_apigatewayv2_integration" "jmap" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api_jmap.invoke_arn
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

resource "aws_lambda_permission" "api_jmap" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_jmap.function_name
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
locals {
  public_routes = {
    "POST /api/auth/login"                        = aws_apigatewayv2_integration.auth.id
    "POST /api/auth/session"                      = aws_apigatewayv2_integration.auth.id
    "POST /api/auth/logout"                       = aws_apigatewayv2_integration.auth.id
    "POST /api/auth"                              = aws_apigatewayv2_integration.auth.id
    "POST /auth/token"                            = aws_apigatewayv2_integration.auth.id
    "POST /auth/revoke"                           = aws_apigatewayv2_integration.auth.id
    "GET /.well-known/oauth-authorization-server" = aws_apigatewayv2_integration.auth.id
  }
}

resource "aws_apigatewayv2_route" "public" {
  for_each = local.public_routes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${each.value}"
}

moved {
  from = aws_apigatewayv2_route.post_login
  to   = aws_apigatewayv2_route.public["POST /api/auth/login"]
}

# Protected routes
locals {
  protected_routes = {
    "GET /api/auth/users"                            = aws_apigatewayv2_integration.auth.id
    "POST /api/auth/users"                           = aws_apigatewayv2_integration.auth.id
    "PATCH /api/auth/users/{email}"                  = aws_apigatewayv2_integration.auth.id
    "DELETE /api/auth/users/{email}"                 = aws_apigatewayv2_integration.auth.id
    "GET /.well-known/jmap"                          = aws_apigatewayv2_integration.jmap.id
    "POST /jmap/api"                                 = aws_apigatewayv2_integration.jmap.id
    "GET /jmap/download/{accountId}/{blobId}/{name}" = aws_apigatewayv2_integration.jmap.id
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
