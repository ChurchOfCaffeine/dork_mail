// ─── Email ───────────────────────────────────────────────────────────────────

export interface StoredEmail {
  /** DynamoDB PK: "mailbox#user@domain.com" */
  pk: string;
  /** DynamoDB SK: "ts#<ISO8601>#<messageId>" — sorts chronologically */
  sk: string;
  /** folder-index GSI hash key: "mailbox#<email>#<folder>" */
  mailboxFolder: string;
  threadId: string;
  /** thread-index GSI hash key: "mailbox#<email>#<threadId>" */
  mailboxThread: string;

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
  /** S3 key of the raw .eml, empty for drafts */
  rawKey: string;
  /** Raw message size in bytes */
  size?: number;

  /** When this server received or stored it, ISO8601. Sorts the mailbox. */
  receivedAt: string;
  /** The sender's Date header, ISO8601 */
  sentAt?: string;
  read: boolean;
  starred: boolean;
  labels: string[];
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
  /** Content-ID without angle brackets, referenced as cid: from the HTML body */
  contentId?: string;
}

export const MAIL_FOLDERS = ["inbox", "archive", "drafts", "sent", "trash", "spam"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** Fields projected into folder-index, which Email/query scans. */
export type EmailSummary = Pick<
  StoredEmail,
  "sk" | "messageId" | "threadId" | "from" | "to" | "cc" | "subject" | "snippet" | "searchText" | "receivedAt" | "read" | "starred" | "labels" | "folder" | "attachments"
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
  textSignature?: string;
  htmlSignature?: string;
  /** Sparse user-index GSI hash key, always "user" */
  entity?: "user";
  /** Unix seconds; access tokens issued before this are rejected by the authorizer */
  tokensValidAfter?: number;
  failedLogins?: number;
  /** Unix seconds */
  lockedUntil?: number;
}

/** User record with sensitive fields omitted — safe to return from API */
export interface UserPublic {
  email: string;
  displayName: string;
  createdAt: string;
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

