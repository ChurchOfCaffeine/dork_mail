// ─── Email ───────────────────────────────────────────────────────────────────

export interface StoredEmail {
  /** DynamoDB PK: "mailbox#user@domain.com" */
  pk: string;
  /** DynamoDB SK: "ts#<ISO8601>#<messageId>" — sorts chronologically */
  sk: string;

  messageId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  /** S3 keys for attachments */
  attachments?: Attachment[];
  /** S3 key of the raw .eml */
  rawKey: string;

  receivedAt: string; // ISO8601
  read: boolean;
  starred: boolean;
  labels: string[];
  /** "inbox" | "sent" | "draft" | "trash" | "spam" */
  folder: MailFolder;

  /** For sent mail — SES message ID */
  sesMessageId?: string;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  s3Key: string;
}

export type MailFolder = "inbox" | "sent" | "draft" | "trash" | "spam";

// ─── User / Mailbox ───────────────────────────────────────────────────────────

export interface User {
  /** DynamoDB PK: "user#<email>" */
  pk: string;
  /** DynamoDB SK: "profile" */
  sk: string;

  email: string;
  /** bcrypt hash */
  passwordHash: string;
  displayName: string;
  createdAt: string;
  /** Whether this user can manage domain settings */
  isAdmin: boolean;
}

export interface Mailbox {
  /** DynamoDB PK: "mailbox#<email>" */
  pk: string;
  /** DynamoDB SK: "config" */
  sk: string;

  address: string;
  /** Owner user email */
  owner: string;
  createdAt: string;
}

// ─── DNS / Setup Wizard ───────────────────────────────────────────────────────

export interface DnsCheckResult {
  domain: string;
  mx: DnsRecord[];
  spf: DnsRecord | null;
  dkim: DkimRecord[];
  dmarc: DnsRecord | null;
  /** Records that are missing or incorrect — each is ready to apply as-is */
  issues: DnsRecord[];
  sesVerified: boolean;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: number;
  present: boolean;
  correct: boolean;
}

export interface DkimRecord extends DnsRecord {
  selector: string;
}


// ─── API contracts ────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AuthTokenPayload {
  sub: string;   // user email
  iat: number;
  exp: number;
  isAdmin: boolean;
}

export interface SendEmailRequest {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  replyToMessageId?: string;
}

export interface ListEmailsRequest {
  mailbox: string;
  folder?: MailFolder;
  limit?: number;
  cursor?: string;
}

export interface ListEmailsResponse {
  emails: StoredEmail[];
  nextCursor?: string;
}
