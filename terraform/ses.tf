# ─── SES Domain Identity ──────────────────────────────────────────────────────

resource "aws_ses_domain_identity" "mail" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "mail" {
  domain = aws_ses_domain_identity.mail.domain
}

# DKIM CNAME records
resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = local.hosted_zone_id
  name    = "${aws_ses_domain_dkim.mail.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_ses_domain_dkim.mail.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Domain verification TXT record
resource "aws_route53_record" "ses_verification" {
  zone_id = local.hosted_zone_id
  name    = "_amazonses.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = [aws_ses_domain_identity.mail.verification_token]
}

resource "aws_ses_domain_identity_verification" "mail" {
  domain = aws_ses_domain_identity.mail.domain
  depends_on = [aws_route53_record.ses_verification]
}

# MX record pointing inbound mail to SES
resource "aws_route53_record" "mx" {
  zone_id = local.hosted_zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 300
  records = ["10 ${local.ses_inbound_ep}"]
}

# SPF TXT record
resource "aws_route53_record" "spf" {
  zone_id = local.hosted_zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC TXT record
resource "aws_route53_record" "dmarc" {
  zone_id = local.hosted_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=quarantine; rua=mailto:dmarc@${var.domain}"]
}

# ─── SES Receipt Rules ────────────────────────────────────────────────────────

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = var.ses_rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

resource "aws_ses_receipt_rule" "store" {
  name          = "store-to-s3"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  enabled       = true
  scan_enabled  = true

  # Accept all mail for the domain
  recipients = [var.domain]

  s3_action {
    bucket_name       = aws_s3_bucket.emails.id
    object_key_prefix = "incoming/"
    position          = 1
  }

  depends_on = [aws_s3_bucket_policy.ses_put]
}

# ─── SES Configuration Set (for sending metrics) ──────────────────────────────

resource "aws_ses_configuration_set" "main" {
  name = "${local.name_prefix}-sending"

  delivery_options {
    tls_policy = "Require"
  }
}
