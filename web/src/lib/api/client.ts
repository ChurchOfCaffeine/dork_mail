/**
 * Typed API client. All calls go through /api (proxied to API Gateway).
 * Auth token is read from localStorage and attached automatically.
 */
import type {
  ApiResponse,
  StoredEmail,
  ListEmailsResponse,
  SendEmailRequest,
  DnsCheckResult,
  DnsRecord,
  UserPublic,
  UnreadCounts,
  UploadResponse,
  PushSubscriptionRequest,
} from "@dork-mail/shared";
import { auth } from "$lib/stores/auth.svelte";

const BASE = "/api";

function token(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem("token") : null;
}

function clearAuthAndRedirect() {
  auth.logout();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  noAuth = false,
  keepalive = false,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!noAuth) {
    const t = token();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive,
    });
  } catch {
    throw new Error(navigator.onLine ? "Network error" : "You're offline");
  }

  let data: ApiResponse<T> | { message?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body, handled below
  }

  // The API Gateway authorizer rejects expired/invalid tokens with 401 or 403
  // and a raw { message } body. Our handlers' own 403s carry `ok: false` and
  // are ordinary errors.
  if (!noAuth && (res.status === 401 || (res.status === 403 && !(data && "ok" in data)))) {
    clearAuthAndRedirect();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!data || !("ok" in data)) {
    throw new Error(`HTTP ${res.status}`);
  }

  if (!data.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  return data.data as T;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  return request<{ token: string; email: string; displayName: string; isAdmin: boolean }>(
    "POST", "/auth/login", { email, password }, true
  );
}

export async function createUser(email: string, password: string, displayName: string, isAdmin = false) {
  return request<{ email: string; displayName: string }>(
    "POST", "/auth/users", { email, password, displayName, isAdmin }
  );
}

export async function listUsers() {
  return request<UserPublic[]>("GET", "/auth/users");
}

export async function updateUser(
  email: string,
  patch: { displayName?: string; currentPassword?: string; newPassword?: string; isAdmin?: boolean }
) {
  return request<{ email: string }>("PATCH", `/auth/users/${encodeURIComponent(email)}`, patch);
}

export async function deleteUser(email: string) {
  return request<void>("DELETE", `/auth/users/${encodeURIComponent(email)}`);
}

// ─── Mail ─────────────────────────────────────────────────────────────────────

export async function listEmails(folder = "inbox", cursor?: string, limit = 50, q?: string) {
  const qs = new URLSearchParams({ folder, limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  if (q) qs.set("q", q);
  return request<ListEmailsResponse>("GET", `/mail?${qs}`);
}

export async function getUnreadCounts() {
  return request<UnreadCounts>("GET", "/mail/counts");
}

export async function getEmail(messageId: string) {
  return request<StoredEmail>("GET", `/mail/${encodeURIComponent(messageId)}`);
}

export async function sendEmail(payload: SendEmailRequest, keepalive = false) {
  return request<{ messageId: string }>("POST", "/mail/send", payload, false, keepalive);
}

export async function createUpload(file: { filename: string; contentType: string; size: number }) {
  return request<UploadResponse>("POST", "/mail/uploads", file);
}

export async function updateEmail(
  messageId: string,
  patch: Partial<Pick<StoredEmail, "read" | "starred" | "labels" | "folder">>
) {
  return request<void>("PATCH", `/mail/${encodeURIComponent(messageId)}`, patch);
}

export async function deleteEmail(messageId: string) {
  return request<{ deleted: boolean; folder?: string }>(
    "DELETE", `/mail/${encodeURIComponent(messageId)}`
  );
}

export async function getAttachmentUrl(messageId: string, s3Key: string, inline = false) {
  return request<{ url: string }>(
    "GET", `/mail/${encodeURIComponent(messageId)}/attachment/${encodeURIComponent(s3Key)}${inline ? "?inline=1" : ""}`
  );
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function getPushKey() {
  return request<{ publicKey: string }>("GET", "/push/key");
}

export async function pushSubscribe(sub: PushSubscriptionRequest) {
  return request<void>("POST", "/push/subscribe", sub);
}

export async function pushUnsubscribe(endpoint: string) {
  return request<void>("POST", "/push/unsubscribe", { endpoint });
}

// ─── DNS / Setup Wizard ───────────────────────────────────────────────────────

export async function checkDns() {
  return request<DnsCheckResult>("GET", "/dns/check");
}

export async function applyDns(records: DnsRecord[]) {
  return request<{ applied: number }>("POST", "/dns/apply", { records });
}

export async function getSesStatus() {
  return request<{
    verificationStatus: string;
    dkim: unknown;
    inSandbox: boolean;
    quota: { max24Hour: number; maxSendRate: number; sentLast24Hours: number };
    productionReview: { status: string; caseId?: string } | null;
  }>("GET", "/dns/ses-status");
}

export async function requestProductionAccess(websiteUrl: string, useCaseDescription: string) {
  return request<{ message: string }>("POST", "/dns/request-production-access", { websiteUrl, useCaseDescription });
}

export async function triggerSesVerify() {
  return request<{ verificationToken: string; dkimTokens: string[] }>("POST", "/dns/ses-verify");
}

export async function listVerifiedEmails() {
  return request<{ email: string; status: string }[]>("GET", "/dns/verified-emails");
}

export async function addVerifiedEmail(email: string) {
  return request<{ message: string }>("POST", "/dns/verified-emails", { email });
}

export async function removeVerifiedEmail(email: string) {
  return request<void>("DELETE", `/dns/verified-emails/${encodeURIComponent(email)}`);
}
