# Single table design — all entities share this table.
# Access patterns:
#   - List emails by mailbox+folder:  folder-index  mailboxFolder=mailbox#<email>#<folder>, SK desc
#   - List emails in a thread:        thread-index  mailboxThread=mailbox#<email>#<threadId>, SK asc
#   - Find email by Message-ID:       message-index PK=mailbox#<email>  messageId=<id>
#   - Mailbox JMAP state and changes: PK=mailbox#<email>  SK=state, SK begins_with chg#
#   - Get user profile:               PK=user#<email>     SK=profile
#   - List users:                     user-index          entity=user, set only on profiles
#   - List refresh tokens:            PK=user#<email>     SK begins_with refresh#
#   - Redeem an authorization code:   PK=authcode#<hash>  SK=code

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
  attribute {
    name = "mailboxThread"
    type = "S"
  }
  attribute {
    name = "entity"
    type = "S"
  }

  # Projects only what Email/query filters on, so scans stay small.
  # Must cover SUMMARY_FIELDS in functions/src/lib/mail-store.ts.
  global_secondary_index {
    name = "folder-index"
    key_schema {
      attribute_name = "mailboxFolder"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "sk"
      key_type       = "RANGE"
    }
    projection_type = "INCLUDE"
    non_key_attributes = [
      "messageId", "threadId", "from", "to", "cc", "subject", "snippet", "searchText",
      "receivedAt", "read", "starred", "labels", "folder", "attachments",
    ]
  }

  global_secondary_index {
    name = "thread-index"
    key_schema {
      attribute_name = "mailboxThread"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "sk"
      key_type       = "RANGE"
    }
    projection_type = "KEYS_ONLY"
  }

  global_secondary_index {
    name = "user-index"
    key_schema {
      attribute_name = "entity"
      key_type       = "HASH"
    }
    projection_type    = "INCLUDE"
    non_key_attributes = ["email", "displayName", "createdAt", "isAdmin"]
  }

  global_secondary_index {
    name = "message-index"
    key_schema {
      attribute_name = "pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "messageId"
      key_type       = "RANGE"
    }
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
    entity       = { S = "user" }
  })

  lifecycle {
    ignore_changes = all
  }
}
