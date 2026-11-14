// ─── Email ───────────────────────────────────────────────────────────────────

export interface StoredEmail {
  /** DynamoDB PK: "mailbox#user@domain.com" */
  pk: string;
  /** DynamoDB SK: "ts#<ISO8601>#<messageId>" — sorts chronologically */
  sk: string;
  /** folder-index GSI hash key: "mailbox#<email>#<folder>" */
  mailboxFolder: string;

  messageId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  /** First ~200 chars of the plain text body, for list previews */
  snippet?: string;
  /** Lowercased from/to/subject/snippet, matched by folder search */
  searchText?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** S3 key of a JSON { bodyText, bodyHtml } object when the bodies are too large for DynamoDB */
  bodyKey?: string;
  inReplyTo?: string;
  references?: string[];
  /** S3 keys for attachments */
  attachments?: Attachment[];
  /** S3 key of the raw .eml */
  rawKey: string;

  receivedAt: string; // ISO8601
  read: boolean;
  starred: boolean;
  labels: string[];
  folder: MailFolder;

  /** For sent mail — SES message ID */
  sesMessageId?: string;
  /** For received mail — the alias address it was delivered through, if any */
  deliveredVia?: string;
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
  /** Content-ID without angle brackets, referenced as cid: from the HTML body */
  contentId?: string;
  /** Short-lived URL, only set on single-message responses for inline cid: images */
  url?: string;
}

export const MAIL_FOLDERS = ["inbox", "archive", "sent", "trash", "spam"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** Fields returned by list queries. Bodies are only returned by the single-message endpoint. */
export type EmailSummary = Pick<
  StoredEmail,
  "messageId" | "from" | "to" | "cc" | "subject" | "snippet" | "receivedAt" | "read" | "starred" | "labels" | "folder" | "attachments"
>;

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

/** User record with sensitive fields omitted — safe to return from API */
export interface UserPublic {
  email: string;
  displayName: string;
  createdAt: string;
  isAdmin: boolean;
}

/**
 * An extra address on the domain that delivers to one user's mailbox. Stored
 * twice in one transaction: a lookup item (pk "alias#<address>", sk "alias")
 * for ingest, and an index item (pk "user#<owner>", sk "alias#<address>") for
 * listing an owner's aliases.
 */
export interface Alias {
  pk: string;
  sk: string;

  address: string;
  /** Email of the user the alias delivers to */
  owner: string;
  /** Free-text note, e.g. where the address was given out */
  label?: string;
  /** Disabled aliases drop incoming mail and can't be sent from */
  enabled: boolean;
  createdAt: string;
}

export type AliasPublic = Omit<Alias, "pk" | "sk">;

export interface CreateAliasRequest {
  /** Part before the @. Generated when omitted or blank. */
  localPart?: string;
  label?: string;
  /** Admin only: the user to deliver to. Defaults to the caller. */
  owner?: string;
}

export interface UpdateAliasRequest {
  label?: string;
  enabled?: boolean;
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
  /** MX record for the custom MAIL FROM subdomain (bounces.{domain}) */
  mailFromMx: DnsRecord | null;
  /** SPF record for the custom MAIL FROM subdomain (bounces.{domain}) */
  mailFromSpf: DnsRecord | null;
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

export interface OutgoingAttachment {
  /** An uploads/ key from POST /mail/uploads, or an attachment key of the forwardOf message */
  s3Key: string;
  filename: string;
  contentType: string;
}

export interface SendEmailRequest {
  /** Address to send as: the caller's own address (the default) or one of their enabled aliases */
  from?: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  /** messageId of the message being replied to; sets In-Reply-To and References */
  inReplyTo?: string;
  /** messageId of the message being forwarded; allows its attachments in `attachments` */
  forwardOf?: string;
  attachments?: OutgoingAttachment[];
}

export interface UploadRequest {
  filename: string;
  contentType: string;
  size: number;
}

export interface UploadResponse {
  s3Key: string;
  uploadUrl: string;
}

export interface ListEmailsResponse {
  emails: EmailSummary[];
  nextCursor?: string;
}

export interface UnreadCounts {
  inbox: number;
  spam: number;
}

export interface PushSubscriptionRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
