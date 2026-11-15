# JMAP blob uploads (POST /jmap/upload/{accountId}) go straight to S3 through a
# REST API service integration. HTTP APIs have no S3 integration, and a Lambda
# in the path would cap uploads at Lambda's 6 MB payload instead of API
# Gateway's 10 MB.
#
# API Gateway treats a body as binary only when its Content-Type is in
# binary_media_types, and renders the response template only when Accept is
# not. The jmap_upload CloudFront function in cloudfront.tf moves the real type
# to X-Blob-Type and pins both headers so any file type passes through intact.

resource "aws_api_gateway_rest_api" "upload" {
  name               = "${local.name_prefix}-upload"
  binary_media_types = ["application/octet-stream"]

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "jmap" {
  rest_api_id = aws_api_gateway_rest_api.upload.id
  parent_id   = aws_api_gateway_rest_api.upload.root_resource_id
  path_part   = "jmap"
}

resource "aws_api_gateway_resource" "upload" {
  rest_api_id = aws_api_gateway_rest_api.upload.id
  parent_id   = aws_api_gateway_resource.jmap.id
  path_part   = "upload"
}

resource "aws_api_gateway_resource" "upload_account" {
  rest_api_id = aws_api_gateway_rest_api.upload.id
  parent_id   = aws_api_gateway_resource.upload.id
  path_part   = "{accountId}"
}

resource "aws_api_gateway_authorizer" "upload" {
  name                             = "jwt"
  rest_api_id                      = aws_api_gateway_rest_api.upload.id
  type                             = "REQUEST"
  authorizer_uri                   = aws_lambda_function.authorizer.invoke_arn
  identity_source                  = "method.request.header.Authorization"
  authorizer_result_ttl_in_seconds = 300
}

resource "aws_lambda_permission" "authorizer_upload" {
  statement_id  = "AllowUploadAPIInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.upload.execution_arn}/*"
}

resource "aws_api_gateway_method" "upload" {
  rest_api_id   = aws_api_gateway_rest_api.upload.id
  resource_id   = aws_api_gateway_resource.upload_account.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.upload.id

  request_parameters = {
    "method.request.header.X-Blob-Type"    = false
    "method.request.header.Content-Length" = false
  }
}

# The key comes from the authorizer, so the accountId in the path can't point at another mailbox.
resource "aws_api_gateway_integration" "upload" {
  rest_api_id             = aws_api_gateway_rest_api.upload.id
  resource_id             = aws_api_gateway_resource.upload_account.id
  http_method             = aws_api_gateway_method.upload.http_method
  type                    = "AWS"
  integration_http_method = "PUT"
  uri                     = "arn:aws:apigateway:${var.aws_region}:s3:path/${aws_s3_bucket.emails.id}/uploads/{account}/{key}"
  credentials             = aws_iam_role.upload_api.arn
  passthrough_behavior    = "WHEN_NO_MATCH"

  request_parameters = {
    "integration.request.path.account"        = "context.authorizer.accountId"
    "integration.request.path.key"            = "context.requestId"
    "integration.request.header.Content-Type" = "method.request.header.X-Blob-Type"
  }
}

resource "aws_api_gateway_method_response" "upload_created" {
  rest_api_id = aws_api_gateway_rest_api.upload.id
  resource_id = aws_api_gateway_resource.upload_account.id
  http_method = aws_api_gateway_method.upload.http_method
  status_code = "201"
}

resource "aws_api_gateway_method_response" "upload_failed" {
  rest_api_id = aws_api_gateway_rest_api.upload.id
  resource_id = aws_api_gateway_resource.upload_account.id
  http_method = aws_api_gateway_method.upload.http_method
  status_code = "502"
}

# blobId "U<requestId>" is parsed by parseBlobId in functions/src/jmap/ids.ts.
resource "aws_api_gateway_integration_response" "upload_created" {
  rest_api_id      = aws_api_gateway_rest_api.upload.id
  resource_id      = aws_api_gateway_resource.upload_account.id
  http_method      = aws_api_gateway_method.upload.http_method
  status_code      = aws_api_gateway_method_response.upload_created.status_code
  content_handling = "CONVERT_TO_TEXT"

  response_templates = {
    "application/json" = <<-VTL
      #set($size = $input.params('Content-Length'))
      {"accountId":"$context.authorizer.accountId","blobId":"U$context.requestId","type":"$util.escapeJavaScript($input.params('X-Blob-Type')).replaceAll("\\'","'")","size":#if($size != "")$size#{else}0#end}
    VTL
  }

  depends_on = [aws_api_gateway_integration.upload]
}

resource "aws_api_gateway_integration_response" "upload_failed" {
  rest_api_id       = aws_api_gateway_rest_api.upload.id
  resource_id       = aws_api_gateway_resource.upload_account.id
  http_method       = aws_api_gateway_method.upload.http_method
  status_code       = aws_api_gateway_method_response.upload_failed.status_code
  selection_pattern = "[45]\\d{2}"
  content_handling  = "CONVERT_TO_TEXT"

  response_templates = {
    "application/json" = "{\"type\":\"urn:ietf:params:jmap:error:serverFail\",\"status\":502}"
  }

  depends_on = [aws_api_gateway_integration.upload]
}

resource "aws_api_gateway_deployment" "upload" {
  rest_api_id = aws_api_gateway_rest_api.upload.id

  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_method.upload,
      aws_api_gateway_integration.upload,
      aws_api_gateway_integration_response.upload_created,
      aws_api_gateway_integration_response.upload_failed,
      aws_api_gateway_authorizer.upload,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "upload" {
  rest_api_id   = aws_api_gateway_rest_api.upload.id
  deployment_id = aws_api_gateway_deployment.upload.id
  stage_name    = "prod"
}

resource "aws_iam_role" "upload_api" {
  name = "${local.name_prefix}-upload-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "apigateway.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "upload_api" {
  name = "upload-perms"
  role = aws_iam_role.upload_api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "${aws_s3_bucket.emails.arn}/uploads/*"
    }]
  })
}
