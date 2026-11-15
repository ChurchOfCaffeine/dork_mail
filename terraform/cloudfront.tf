# ─── SPA routing function ─────────────────────────────────────────────────────
# Maps routes to the HTML shell that serves them: Bulwark Lite at the root, with
# one shell per /<locale>/<surface>, and the SvelteKit admin app under /admin.
# This replaces custom_error_response, which applied to ALL origins and
# converted API 403/404s into HTML pages.

resource "aws_cloudfront_function" "spa_router" {
  name    = "${local.name_prefix}-spa-router"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    async function handler(event) {
      const uri = event.request.uri;
      if (/\.[a-zA-Z0-9]+$/.test(uri)) {
        return event.request;
      }
      if (uri === '/admin' || uri.startsWith('/admin/')) {
        event.request.uri = '/admin/index.html';
        return event.request;
      }
      const surface = uri.match(/^\/([a-zA-Z-]+)\/(mail|calendar|contacts|files|settings)(\/.*)?$/);
      if (surface) {
        event.request.uri = '/' + surface[1] + '/' + surface[2] + '/index.html';
        return event.request;
      }
      event.request.uri = uri.replace(/\/?$/, '/index.html');
      return event.request;
    }
  JS
}

# See terraform/upload.tf for why uploads need these headers rewritten.
resource "aws_cloudfront_function" "jmap_upload" {
  name    = "${local.name_prefix}-jmap-upload"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    async function handler(event) {
      const headers = event.request.headers;
      headers['x-blob-type'] = { value: headers['content-type'] ? headers['content-type'].value : 'application/octet-stream' };
      headers['content-type'] = { value: 'application/octet-stream' };
      headers['accept'] = { value: 'application/json' };
      return event.request;
    }
  JS
}

# Bulwark's own _headers policy, which S3 can't serve.
resource "aws_cloudfront_response_headers_policy" "web" {
  name = "${local.name_prefix}-web"

  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = false
      override                   = true
    }
    # Everything Bulwark calls is same-origin except the presigned S3 URLs that downloads redirect to.
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https: data:; connect-src 'self' https://${aws_s3_bucket.emails.id}.s3.${var.aws_region}.amazonaws.com https://${aws_s3_bucket.emails.id}.s3.amazonaws.com; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; media-src 'self' blob:"
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=()"
      override = true
    }
  }
}

# ─── TLS Certificate (must be in us-east-1 for CloudFront) ───────────────────

resource "aws_acm_certificate" "web" {
  provider          = aws.us_east_1
  domain_name       = local.web_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.web.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = local.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "web" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.web.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ─── CloudFront OAC ───────────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name_prefix}-oac"
  description                       = "OAC for Dork Mail web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ─── Cache and origin request policies ───────────────────────────────────────
# With caching disabled, AllViewerExceptHostHeader forwards Authorization and the
# dm_session cookie. Excluding Host lets API Gateway match its own endpoint name.

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# ─── CloudFront Distribution ──────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [local.web_fqdn]
  price_class         = "PriceClass_100"

  # Origin 1: S3 static assets
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "s3-web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  # Origin 2: API Gateway
  origin {
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
    origin_id   = "api-gw"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Origin 3: upload REST API, terraform/upload.tf
  origin {
    domain_name = "${aws_api_gateway_rest_api.upload.id}.execute-api.${var.aws_region}.amazonaws.com"
    origin_id   = "upload-api"
    origin_path = "/${aws_api_gateway_stage.upload.stage_name}"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default: S3 with SPA router — rewrites unknown paths to /index.html
  # No custom_error_response needed, so API errors are never converted to HTML.
  default_cache_behavior {
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_router.arn
    }

    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  # Must come before /jmap/*, CloudFront takes the first matching behavior.
  ordered_cache_behavior {
    path_pattern             = "/jmap/upload/*"
    target_origin_id         = "upload-api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.jmap_upload.arn
    }
  }

  # API Gateway, no caching, errors pass through as-is
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/jmap/*", "/auth/*", "/.well-known/*"]
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "api-gw"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ─── DNS record for web subdomain ─────────────────────────────────────────────

resource "aws_route53_record" "web" {
  zone_id = local.hosted_zone_id
  name    = local.web_fqdn
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}
