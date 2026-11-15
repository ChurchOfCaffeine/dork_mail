/**
 * Auth API: login and user management.
 * POST   /api/auth/login
 * GET    /api/auth/users              (admin)
 * POST   /api/auth/users              (admin)
 * PATCH  /api/auth/users/:email       (admin or self)
 * DELETE /api/auth/users/:email       (admin)
 *
 * Token login in the shape of Stalwart's, which Bulwark Lite speaks:
 * POST   /api/auth                    password + PKCE challenge -> authorization code
 * POST   /auth/token                  authorization_code or refresh_token grant
 * POST   /auth/revoke                 RFC 7009 refresh token revocation
 * GET    /.well-known/oauth-authorization-server
 *
 * Admin app sessions ride on Bulwark's sign-in through an HttpOnly cookie:
 * POST   /api/auth/session            cookie -> API token
 * POST   /api/auth/logout             revokes the cookie's session
 */
import { createHash, randomBytes } from "node:crypto";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import isEmail from "validator/lib/isEmail";
import { MAIL_FOLDERS, type User, type UserPublic, type AuthTokenPayload } from "@dork-mail/shared";
import { json, parseBody, withErrors } from "../lib/http";
import { mailboxPk } from "../lib/mail-store";
import { storeCounts, type FolderCounts } from "../lib/mail-state";
import { accountIdFor } from "../jmap/ids";

const logger = new Logger({ serviceName: "api-auth" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-auth" });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.EMAIL_BUCKET!;
const JWT_PARAM = process.env.JWT_SECRET_PARAM!;
const DOMAIN = process.env.MAIL_DOMAIN!.toLowerCase();
const ORIGIN = process.env.WEB_ORIGIN!;
const USER_INDEX = "user-index";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
// Two tabs can refresh with the same token at once; the loser still needs a working token.
const REFRESH_REUSE_GRACE_SECONDS = 60;
const AUTH_CODE_TTL_SECONDS = 300;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 15 * 60;
// Compared against when the user doesn't exist, so unknown and known emails take the same time.
const DUMMY_HASH = "$2b$12$70/x0EV03M8ImIJbfT9m6.LK3oek5xYDpzTcuAeFMnOJTyvxWOoMO";

/** Minimum 12 chars, at least one uppercase, one digit, one special char */
function isStrongPassword(pwd: string): boolean {
  return pwd.length >= 12
    && /[A-Z]/.test(pwd)
    && /[0-9]/.test(pwd)
    && /[^A-Za-z0-9]/.test(pwd);
}

export const handler = withErrors(logger, async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path;
  const method = event.httpMethod;

  if (method === "POST" && path === "/api/auth") return authCode(event);
  if (method === "POST" && path === "/auth/token") return token(event);
  if (method === "POST" && path === "/auth/revoke") return revoke(event);
  if (method === "GET"  && path === "/.well-known/oauth-authorization-server") return oauthMetadata();
  if (method === "POST" && path === "/api/auth/session") return session(event);
  if (method === "POST" && path === "/api/auth/logout") return logout(event);
  if (method === "POST" && path.endsWith("/login")) return login(event);
  if (method === "GET"  && path.endsWith("/users")) return listUsers(event);
  if (method === "POST" && path.endsWith("/users")) return createUser(event);

  const userEmailMatch = path.match(/\/users\/([^/]+)$/);
  if (userEmailMatch) {
    const targetEmail = decodeURIComponent(userEmailMatch[1]);
    if (method === "PATCH")  return updateUser(event, targetEmail);
    if (method === "DELETE") return deleteUser(event, targetEmail);
  }

  return json(404, { ok: false, error: "Not found" });
});

async function login(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ email: string; password: string }>(event.body);
  if (!body?.email || !body?.password) {
    return json(400, { ok: false, error: "email and password required" });
  }

  const user = await checkPassword(body.email, body.password);
  // Same error for unknown user and wrong password, to avoid enumeration
  if (!user) return json(401, { ok: false, error: "Invalid credentials" });

  const token = await signToken(user, ACCESS_TOKEN_TTL_SECONDS);
  return json(200, { ok: true, data: { token, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin } });
}

async function getUser(email: string): Promise<User | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `user#${email}`, sk: "profile" } }));
  return result.Item as User | undefined;
}

/** Accepts a bare username as well as a full address, since every mailbox is on the one domain. */
async function checkPassword(rawEmail: string, password: string): Promise<User | null> {
  const name = rawEmail.toLowerCase().trim();
  const email = name.includes("@") ? name : `${name}@${DOMAIN}`;
  const user = await getUser(email);
  const locked = (user?.lockedUntil ?? 0) > nowSeconds();
  // A locked account still pays for a hash, so its answer takes as long as any other.
  const passwordOk = await bcrypt.compare(password, (!locked && user?.passwordHash) || DUMMY_HASH) && !locked;
  metrics.addMetric(user && passwordOk ? "LoginSuccess" : locked ? "LoginLocked" : "LoginFailure", MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  if (user && !passwordOk && !locked) await recordFailedLogin(user);
  if (!user || !passwordOk) return null;
  if (user.failedLogins) await updateProfile(user.email, "REMOVE failedLogins, lockedUntil");
  logger.info("Login", { email });
  return user;
}

/** Locks the account for a doubling interval once failures reach MAX_FAILED_LOGINS. */
async function recordFailedLogin(user: User): Promise<void> {
  const failures = (user.failedLogins ?? 0) + 1;
  const over = failures - MAX_FAILED_LOGINS;
  if (over < 0) {
    await updateProfile(user.email, "SET failedLogins = :n", { ":n": failures });
    return;
  }
  const lockedUntil = nowSeconds() + Math.min(LOCKOUT_BASE_SECONDS * 2 ** over, LOCKOUT_MAX_SECONDS);
  await updateProfile(user.email, "SET failedLogins = :n, lockedUntil = :until", { ":n": failures, ":until": lockedUntil });
  logger.warn("Account locked", { email: user.email, failures, lockedUntil });
}

/** Updates an existing profile; a concurrent delete wins instead of leaving a profile with no password. */
async function updateProfile(email: string, expression: string, values?: Record<string, unknown>): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `user#${email}`, sk: "profile" },
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
  }
}

async function signToken(user: User, ttlSeconds: number): Promise<string> {
  const secret = await getParameter(JWT_PARAM, { decrypt: true }) as string;
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthTokenPayload = { sub: user.email, iat: now, exp: now + ttlSeconds, isAdmin: user.isAdmin };
  return jwt.sign(payload, secret, { algorithm: "HS256" });
}

// ─── Token login ──────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1000);
const refreshSk = (refreshToken: string) => `refresh#${sha256(refreshToken)}`;

function oauth(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }, body: JSON.stringify(body) };
}

// Carries Bulwark's refresh token to the admin app. Bulwark's own copy is sealed in IndexedDB where only Bulwark can use it.
const SESSION_COOKIE = "dm_session";
const setSessionCookie = (refreshToken: string) => ({
  "Set-Cookie": `${SESSION_COOKIE}=${refreshToken}; Path=/; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
});
const clearSessionCookie = { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` };

function sessionCookie(event: APIGatewayProxyEvent): string {
  const header = event.headers?.Cookie ?? event.headers?.cookie ?? "";
  return header.split(/;\s*/).find(c => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
}

const refreshKey = (refreshToken: string) => ({
  pk: `user#${Buffer.from(refreshToken.split(".")[0] ?? "", "base64url").toString("utf8")}`,
  sk: refreshSk(refreshToken),
});

/** The user and client a live refresh token belongs to, or null when it's unknown, expired, or its user is gone. */
async function refreshTokenOwner(refreshToken: string): Promise<{ user: User; clientId: string } | null> {
  if (!refreshToken) return null;
  const key = refreshKey(refreshToken);
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  if (!res.Item || res.Item.expiresAt < nowSeconds()) return null;
  const user = await getUser(key.pk.slice("user#".length));
  return user ? { user, clientId: (res.Item.clientId as string | undefined) ?? "" } : null;
}

async function issueRefreshToken(user: User, clientId: string): Promise<string> {
  const refreshToken = `${Buffer.from(user.email).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `user#${user.email}`,
      sk: refreshSk(refreshToken),
      clientId,
      createdAt: new Date().toISOString(),
      expiresAt: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS,
      ttl: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS,
    },
  }));
  return refreshToken;
}

/** Shortens a rotated-out refresh token to the reuse grace window. */
async function retireRefreshToken(refreshToken: string): Promise<void> {
  const until = nowSeconds() + REFRESH_REUSE_GRACE_SECONDS;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: refreshKey(refreshToken),
      UpdateExpression: "SET expiresAt = :until, #ttl = :until",
      ConditionExpression: "expiresAt > :until",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":until": until },
    }));
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
  }
}

function rawBody(event: APIGatewayProxyEvent): string {
  return event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
}

/** Bulwark reads `client_code` from an "authenticated" answer and treats any other type as bad credentials. */
async function authCode(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<{
    type?: string;
    accountName?: string;
    accountSecret?: string;
    clientId?: string;
    redirectUri?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }>(rawBody(event));
  if (body?.type !== "authCode" || !body.accountName || !body.accountSecret || !body.codeChallenge || body.codeChallengeMethod !== "S256") {
    return oauth(400, { type: "invalid", error: "invalid_request" });
  }

  const user = await checkPassword(body.accountName, body.accountSecret);
  if (!user) return oauth(200, { type: "failure" });

  const code = randomBytes(32).toString("base64url");
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `authcode#${sha256(code)}`,
      sk: "code",
      email: user.email,
      clientId: body.clientId ?? "",
      redirectUri: body.redirectUri ?? "",
      codeChallenge: body.codeChallenge,
      expiresAt: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      ttl: nowSeconds() + AUTH_CODE_TTL_SECONDS,
    },
  }));
  return oauth(200, { type: "authenticated", client_code: code });
}

async function token(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const form = new URLSearchParams(rawBody(event));
  const grant = form.get("grant_type");
  const invalid = () => oauth(400, { error: "invalid_grant" });

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const res = await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `authcode#${sha256(code)}`, sk: "code" },
      ReturnValues: "ALL_OLD",
    }));
    const stored = res.Attributes;
    if (!stored || stored.expiresAt < nowSeconds()) return invalid();
    if (stored.clientId !== (form.get("client_id") ?? "") || stored.redirectUri !== (form.get("redirect_uri") ?? "")) return invalid();
    if (sha256(verifier) !== stored.codeChallenge) return invalid();

    const user = await getUser(stored.email);
    if (!user) return invalid();
    const refreshToken = await issueRefreshToken(user, stored.clientId);
    return oauth(200, {
      access_token: await signToken(user, ACCESS_TOKEN_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    }, setSessionCookie(refreshToken));
  }

  if (grant === "refresh_token") {
    const presented = form.get("refresh_token") ?? "";
    const owner = await refreshTokenOwner(presented);
    if (!owner || owner.clientId !== (form.get("client_id") ?? "")) return invalid();
    const refreshToken = await issueRefreshToken(owner.user, owner.clientId);
    await retireRefreshToken(presented);
    // The cookie follows the admin app's session only, not every account signed in to Bulwark.
    const cookie = sessionCookie(event);
    return oauth(200, {
      access_token: await signToken(owner.user, ACCESS_TOKEN_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    }, !cookie || cookie === presented ? setSessionCookie(refreshToken) : {});
  }

  return oauth(400, { error: "unsupported_grant_type" });
}

async function revoke(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const refreshToken = new URLSearchParams(rawBody(event)).get("token") ?? "";
  if (refreshToken) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: refreshKey(refreshToken) }));
  return oauth(200, {}, refreshToken && sessionCookie(event) === refreshToken ? clearSessionCookie : {});
}

/** Admin app sign-in: trades the session cookie Bulwark's sign-in set for an API token. */
async function session(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const user = (await refreshTokenOwner(sessionCookie(event)))?.user;
  if (!user) return json(401, { ok: false, error: "Not signed in" }, clearSessionCookie);
  const token = await signToken(user, ACCESS_TOKEN_TTL_SECONDS);
  return json(200, { ok: true, data: { token, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin } });
}

/** Signs out everywhere the cookie's session is used, Bulwark included. */
async function logout(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const refreshToken = sessionCookie(event);
  if (refreshToken) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: refreshKey(refreshToken) }));
  return json(200, { ok: true }, clearSessionCookie);
}

function oauthMetadata(): APIGatewayProxyResult {
  return oauth(200, {
    issuer: ORIGIN,
    token_endpoint: `${ORIGIN}/auth/token`,
    revocation_endpoint: `${ORIGIN}/auth/revoke`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

async function createUser(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Only admins may create users — enforced by checking context set by authorizer
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) {
    return json(403, { ok: false, error: "Admin only" });
  }

  const body = parseBody<{ email: string; password: string; displayName: string; isAdmin?: boolean }>(event.body);
  if (!body?.email || !body?.password || !body?.displayName) {
    return json(400, { ok: false, error: "email, password, displayName required" });
  }

  if (!isStrongPassword(body.password)) {
    return json(400, { ok: false, error: "Password must be at least 12 characters and include uppercase, digit, and special character" });
  }

  const email = body.email.toLowerCase().trim();
  if (!isEmail(email) || !email.endsWith(`@${DOMAIN}`)) {
    return json(400, { ok: false, error: `Email must be an address on ${DOMAIN}` });
  }
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(body.password, 12);

  const user: User = {
    pk: `user#${email}`,
    sk: "profile",
    email,
    passwordHash,
    displayName: body.displayName,
    createdAt: now,
    isAdmin: body.isAdmin === true,
    entity: "user",
  };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: user,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") {
      return json(409, { ok: false, error: "User already exists" });
    }
    throw err;
  }
  await startMailboxCounts(email);

  logger.info("User created", { email });
  return json(201, { ok: true, data: { email, displayName: body.displayName } });
}

async function listUsers(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) return json(403, { ok: false, error: "Admin only" });

  const users: UserPublic[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: USER_INDEX,
      KeyConditionExpression: "entity = :user",
      ExpressionAttributeValues: { ":user": "user" },
      ProjectionExpression: "email, displayName, createdAt, isAdmin",
      ExclusiveStartKey: startKey,
    }));
    users.push(...(page.Items ?? []) as UserPublic[]);
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  users.sort((a, b) => a.email.localeCompare(b.email));
  return json(200, { ok: true, data: users });
}

/** A new mailbox keeps exact counts from its first email; one with leftover mail waits for `pnpm backfill`. */
async function startMailboxCounts(email: string): Promise<void> {
  const existing = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": mailboxPk(email) },
    ConsistentRead: true,
    Limit: 1,
  }));
  if (existing.Items?.length) return;
  const zero = Object.fromEntries(MAIL_FOLDERS.map(f => [f, { total: 0, unread: 0 }])) as FolderCounts;
  await storeCounts(ddb, TABLE, email, 0, zero);
}

async function updateUser(event: APIGatewayProxyEvent, targetEmail: string): Promise<APIGatewayProxyResult> {
  const callerEmail = event.requestContext.authorizer?.userEmail as string;
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  const isSelf = callerEmail === targetEmail;

  if (!callerIsAdmin && !isSelf) return json(403, { ok: false, error: "Forbidden" });

  const body = parseBody<{
    displayName?: string;
    currentPassword?: string;
    newPassword?: string;
    isAdmin?: boolean;
  }>(event.body);
  if (!body) return json(400, { ok: false, error: "Body required" });

  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `user#${targetEmail}`, sk: "profile" },
  }));
  const user = result.Item as User | undefined;
  if (!user) return json(404, { ok: false, error: "User not found" });

  const sets: string[] = [];
  const values: Record<string, unknown> = {};

  if (body.displayName !== undefined) {
    sets.push("displayName = :displayName");
    values[":displayName"] = body.displayName.trim();
  }

  if (body.newPassword !== undefined) {
    if (!isStrongPassword(body.newPassword)) {
      return json(400, { ok: false, error: "Password must be at least 12 characters and include uppercase, digit, and special character" });
    }
    if (isSelf) {
      if (!body.currentPassword) return json(400, { ok: false, error: "currentPassword required" });
      if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
        return json(403, { ok: false, error: "Current password is incorrect" });
      }
    }
    sets.push("passwordHash = :passwordHash", "tokensValidAfter = :now");
    values[":passwordHash"] = await bcrypt.hash(body.newPassword, 12);
    values[":now"] = nowSeconds();
  }

  if (body.isAdmin !== undefined && callerIsAdmin) {
    sets.push("isAdmin = :isAdmin");
    values[":isAdmin"] = body.isAdmin;
  }

  if (!sets.length) return json(400, { ok: false, error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `user#${targetEmail}`, sk: "profile" },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeValues: values,
  }));
  if (body.newPassword !== undefined) await revokeRefreshTokens(targetEmail);

  logger.info("User updated", { targetEmail, by: callerEmail });
  return json(200, { ok: true, data: { email: targetEmail } });
}

async function deleteUser(event: APIGatewayProxyEvent, targetEmail: string): Promise<APIGatewayProxyResult> {
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) return json(403, { ok: false, error: "Admin only" });

  const callerEmail = event.requestContext.authorizer?.userEmail as string;
  if (callerEmail === targetEmail) return json(400, { ok: false, error: "Cannot delete your own account" });

  // The profile goes last, so a delete that times out still lists the user and can be run again.
  await deletePartition(mailboxPk(targetEmail));
  await deleteAccountObjects(accountIdFor(targetEmail));
  await deletePartition(`user#${targetEmail}`, "profile");
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `user#${targetEmail}`, sk: "profile" } }));

  logger.info("User deleted", { targetEmail, by: callerEmail });
  return json(200, { ok: true });
}

async function deletePartition(pk: string, keepSk?: string): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ProjectionExpression: "pk, sk",
      ExclusiveStartKey: startKey,
    }));
    const keys = (page.Items ?? []).filter(k => k.sk !== keepSk);
    const batches: Record<string, unknown>[][] = [];
    for (let i = 0; i < keys.length; i += 25) batches.push(keys.slice(i, i + 25));
    await Promise.all(batches.map(async batch => {
      let requests = batch.map(Key => ({ DeleteRequest: { Key } }));
      while (requests.length) {
        const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
        requests = (res.UnprocessedItems?.[TABLE] ?? []) as typeof requests;
      }
    }));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

/**
 * Removes the S3 objects only this account's mail uses. Inbound attachments and bodies are keyed by
 * the SES message and shared by every local recipient, so they stay.
 */
async function deleteAccountObjects(accountId: string): Promise<void> {
  for (const prefix of ["raw", "bodies", "attachments", "uploads"].map(p => `${p}/${accountId}/`)) {
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
      const objects = (page.Contents ?? []).map(o => ({ Key: o.Key! }));
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }));
      token = page.NextContinuationToken;
    } while (token);
  }
}

async function revokeRefreshTokens(email: string): Promise<void> {
  const items = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :refresh)",
    ExpressionAttributeValues: { ":pk": `user#${email}`, ":refresh": "refresh#" },
    ProjectionExpression: "pk, sk",
  }));
  await Promise.all((items.Items ?? []).map(key =>
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: key.pk, sk: key.sk } })),
  ));
}
