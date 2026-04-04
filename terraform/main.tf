terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
    }
    archive = {
      source  = "hashicorp/archive"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.tags, {
      Project = "dork-mail"
      Domain  = var.domain
    })
  }
}

# CloudFront requires ACM certificates in us-east-1 regardless of deployment region
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = merge(var.tags, {
      Project = "dork-mail"
      Domain  = var.domain
    })
  }
}

data "aws_route53_zone" "main" {
  name         = var.domain
  private_zone = false
}

locals {
  hosted_zone_id  = data.aws_route53_zone.main.zone_id
  web_fqdn        = "${var.web_subdomain}.${var.domain}"
  name_prefix     = "dork-mail"
  ses_inbound_ep  = "inbound-smtp.${var.aws_region}.amazonaws.com"
}
