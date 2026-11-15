variable "domain" {
  description = "The mail domain, e.g. example.com. A Route 53 hosted zone for this domain must already exist."
  type        = string
}

variable "web_subdomain" {
  description = "Subdomain for the web UI, e.g. 'mail' → mail.example.com."
  type        = string
  default     = "mail"
}

variable "aws_region" {
  description = "AWS region to deploy into. SES email receiving is only available in us-east-1, us-west-2, and eu-west-1."
  type        = string
  default     = "us-east-1"
}

variable "ses_rule_set_name" {
  description = "Name for the SES receipt rule set. Only one rule set can be active per region."
  type        = string
  default     = "dork-mail"
}

variable "jwt_secret" {
  description = "Secret used to sign JWTs. Stored in SSM Parameter Store (SecureString). Generate with: openssl rand -base64 48"
  type        = string
  sensitive   = true
}

variable "admin_email" {
  description = "Email address of the initial admin user. Must match a mailbox on var.domain."
  type        = string
}

variable "admin_password_hash" {
  description = "bcrypt hash of the initial admin password. Generate with: pnpm gen-password-hash"
  type        = string
  sensitive   = true
}

variable "admin_display_name" {
  description = "Display name for the initial admin user."
  type        = string
  default     = "Admin"
}

variable "alert_email" {
  description = "Email address subscribed to alarms, such as inbound mail that failed to ingest. Empty skips the subscription; the alarms still show in CloudWatch."
  type        = string
  default     = ""
}

variable "dmarc_report_email" {
  description = "Address that receives DMARC aggregate reports (rua). Empty publishes DMARC without reports. Use a mailbox that exists, or reports are dropped."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
