# Single table design — all entities share this table.
# Access patterns:
#   - List emails by mailbox+folder:  PK=mailbox#<email>  SK begins_with ts#
#   - Get user profile:               PK=user#<email>     SK=profile
#   - Get mailbox config:             PK=mailbox#<email>  SK=config

resource "aws_dynamodb_table" "main" {
  name         = "${local.name_prefix}-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # GSI for querying by folder efficiently
  # GSI PK: pk  SK: folder#ts# (write as "folder#<folder>#<ts>#<id>")
  # (Optional future optimisation — left as placeholder)

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# ─── Seed admin user ──────────────────────────────────────────────────────────
# Created once on first apply. ignore_changes = all means Terraform never
# overwrites changes made to the user record by the application after that.

resource "aws_dynamodb_table_item" "admin_user" {
  table_name = aws_dynamodb_table.main.name
  hash_key   = aws_dynamodb_table.main.hash_key
  range_key  = aws_dynamodb_table.main.range_key

  item = jsonencode({
    pk           = { S = "user#${var.admin_email}" }
    sk           = { S = "profile" }
    email        = { S = var.admin_email }
    passwordHash = { S = var.admin_password_hash }
    displayName  = { S = var.admin_display_name }
    createdAt    = { S = timestamp() }
    isAdmin      = { BOOL = true }
  })

  lifecycle {
    ignore_changes = all
  }
}
