# Single table design — all entities share this table.
# Access patterns:
#   - List emails by mailbox+folder:  folder-index  mailboxFolder=mailbox#<email>#<folder>, SK desc
#   - Find email by Message-ID:       message-index PK=mailbox#<email>  messageId=<id>
#   - Get user profile:               PK=user#<email>     SK=profile
#   - List push subscriptions:        PK=user#<email>     SK begins_with push#

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
  attribute {
    name = "mailboxFolder"
    type = "S"
  }
  attribute {
    name = "messageId"
    type = "S"
  }

  # Projects only what the message list renders, so list pages stay small.
  # Must cover SUMMARY_FIELDS in functions/src/lib/mail-store.ts, plus searchText for search.
  global_secondary_index {
    name            = "folder-index"
    hash_key        = "mailboxFolder"
    range_key       = "sk"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "messageId", "from", "to", "cc", "subject", "snippet", "searchText",
      "receivedAt", "read", "starred", "labels", "folder", "attachments",
    ]
  }

  global_secondary_index {
    name            = "message-index"
    hash_key        = "pk"
    range_key       = "messageId"
    projection_type = "KEYS_ONLY"
  }

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
