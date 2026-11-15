/**
 * Typed API client. All calls go through /api (proxied to API Gateway).
 * The auth token is attached automatically.
 */
import type {
  ApiResponse,
  DnsCheckResult,
  DnsRecord,
  UserPublic,
} from "@dork-mail/shared";
import { auth } from "#lib/stores/auth.svelte.ts";

const BASE = "/api";

/** Sign-in happens in Bulwark at the root, which also sets the session cookie this app runs on. */
export function redirectToSignIn() {
  auth.logout();
  if (typeof window !== "undefined") window.location.href = "/";
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
    if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
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
    redirectToSignIn();
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

export async function session() {
  return request<{ token: string; email: string; displayName: string; isAdmin: boolean }>(
    "POST", "/auth/session", undefined, true
  );
}

export async function logout() {
  return request<void>("POST", "/auth/logout", undefined, true);
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
