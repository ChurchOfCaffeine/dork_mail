/**
 * Auth API: login, user management, and push subscriptions.
 * POST   /auth/login
 * GET    /auth/users              (admin)
 * POST   /auth/users              (admin)
 * PATCH  /auth/users/:email       (admin or self)
 * DELETE /auth/users/:email       (admin)
 * GET    /aliases                 own aliases (admin: ?owner=<email> or ?all=1)
 * POST   /aliases                 create an alias (admin may set owner)
 * PATCH  /aliases/:address        (owner or admin)
 * DELETE /aliases/:address        (owner or admin)
 * GET    /push/key                VAPID public key, 404 when push is not configured
 * POST   /push/subscribe
 * POST   /push/unsubscribe
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
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
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import isEmail from "validator/lib/isEmail";
import type {
  User,
  UserPublic,
  AuthTokenPayload,
  PushSubscriptionRequest,
  Alias,
  CreateAliasRequest,
  UpdateAliasRequest,
} from "@dork-mail/shared";
import { aliasLocalPartError, generateAliasLocalPart } from "@dork-mail/shared";
import { json, parseBody, caller, withErrors } from "../lib/http";
import { vapidKeys, pushSk } from "../lib/push";
import { aliasKey, ownerAliasKey, getAlias, toPublic } from "../lib/aliases";

const logger = new Logger({ serviceName: "api-auth" });
const tracer = new Tracer({ serviceName: "api-auth" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-auth" });

const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.TABLE_NAME!;
const JWT_PARAM = process.env.JWT_SECRET_PARAM!;
const DOMAIN = process.env.MAIL_DOMAIN!.toLowerCase();
const JWT_TTL_SECONDS = 60 * 60 * 24; // 1 day
// 0 means no limit.
const MAX_ALIASES_PER_USER = Math.max(0, parseInt(process.env.MAX_ALIASES_PER_USER ?? "0", 10) || 0);
const MAX_ALIASES_ON_USER_CREATE = 25;
const MAX_LABEL_LENGTH = 200;
const GENERATE_ATTEMPTS = 5;
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

  if (method === "POST" && path.endsWith("/login")) return login(event);
  if (method === "GET"  && path.endsWith("/users")) return listUsers(event);
  if (method === "POST" && path.endsWith("/users")) return createUser(event);
  if (method === "GET"  && path.endsWith("/push/key")) return pushKey();
  if (method === "POST" && path.endsWith("/push/subscribe")) return pushSubscribe(event);
  if (method === "POST" && path.endsWith("/push/unsubscribe")) return pushUnsubscribe(event);

  if (path.endsWith("/aliases")) {
    if (method === "GET") return listAliases(event);
    if (method === "POST") return createAlias(event);
  }
  const aliasMatch = path.match(/\/aliases\/([^/]+)$/);
  if (aliasMatch) {
    const address = decodeURIComponent(aliasMatch[1]).toLowerCase().trim();
    if (method === "PATCH") return updateAlias(event, address);
    if (method === "DELETE") return deleteAlias(event, address);
  }

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

  const email = body.email.toLowerCase().trim();
  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `user#${email}`, sk: "profile" },
  }));

  const user = result.Item as User | undefined;
  const passwordOk = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    metrics.addMetric("LoginFailure", MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    // Same error for unknown user and wrong password — avoid enumeration
    return json(401, { ok: false, error: "Invalid credentials" });
  }

  const secret = await getParameter(JWT_PARAM, { decrypt: true }) as string;
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthTokenPayload = {
    sub: user.email,
    iat: now,
    exp: now + JWT_TTL_SECONDS,
    isAdmin: user.isAdmin,
  };
  const token = jwt.sign(payload, secret, { algorithm: "HS256" });

  metrics.addMetric("LoginSuccess", MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  logger.info("Login", { email });

  return json(200, { ok: true, data: { token, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin } });
}

async function createUser(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Only admins may create users — enforced by checking context set by authorizer
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) {
    return json(403, { ok: false, error: "Admin only" });
  }

  const body = parseBody<{ email: string; password: string; displayName: string; isAdmin?: boolean; aliases?: string[] }>(event.body);
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

  if (body.aliases !== undefined && !Array.isArray(body.aliases)) {
    return json(400, { ok: false, error: "aliases must be a list of names" });
  }
  const aliasInputs = body.aliases ?? [];
  if (aliasInputs.length > MAX_ALIASES_ON_USER_CREATE) {
    return json(400, { ok: false, error: `At most ${MAX_ALIASES_ON_USER_CREATE} aliases can be created with a user` });
  }
  const aliasAddresses: string[] = [];
  for (const input of aliasInputs) {
    const parsed = parseAliasAddress(String(input));
    if ("error" in parsed) return json(400, { ok: false, error: parsed.error });
    if (parsed.address === email) return json(400, { ok: false, error: "An alias can't be the user's own address" });
    if (!aliasAddresses.includes(parsed.address)) aliasAddresses.push(parsed.address);
  }
  if (MAX_ALIASES_PER_USER && aliasAddresses.length > MAX_ALIASES_PER_USER) {
    return json(400, { ok: false, error: `Users can have at most ${MAX_ALIASES_PER_USER} aliases` });
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
  };

  const aliases = aliasAddresses.map((address): Alias => ({
    ...aliasKey(address), address, owner: email, enabled: true, createdAt: now,
  }));
  const failed = await transact([
    { item: { Put: { TableName: TABLE, Item: user, ConditionExpression: "attribute_not_exists(pk)" } }, conflict: "User already exists" },
    { item: { ConditionCheck: { TableName: TABLE, Key: aliasKey(email), ConditionExpression: "attribute_not_exists(pk)" } }, conflict: `${email} is already an alias` },
    ...aliases.flatMap(a => aliasWrites(a)),
  ]);
  if (failed) return json(409, { ok: false, error: failed });

  logger.info("User created", { email, aliases: aliasAddresses.length });
  return json(201, { ok: true, data: { email, displayName: body.displayName, aliases: aliasAddresses } });
}

async function listUsers(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) return json(403, { ok: false, error: "Admin only" });

  const result = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
    ExpressionAttributeValues: { ":prefix": "user#", ":sk": "profile" },
    ProjectionExpression: "email, displayName, createdAt, isAdmin",
  }));

  const users: UserPublic[] = (result.Items ?? []) as UserPublic[];
  users.sort((a, b) => a.email.localeCompare(b.email));
  return json(200, { ok: true, data: users });
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
    if (isSelf && !callerIsAdmin) {
      // Non-admin updating their own password must provide current password
      if (!body.currentPassword) return json(400, { ok: false, error: "currentPassword required" });
      if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
        return json(403, { ok: false, error: "Current password is incorrect" });
      }
    }
    sets.push("passwordHash = :passwordHash");
    values[":passwordHash"] = await bcrypt.hash(body.newPassword, 12);
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

  logger.info("User updated", { targetEmail, by: callerEmail });
  return json(200, { ok: true, data: { email: targetEmail } });
}

async function deleteUser(event: APIGatewayProxyEvent, targetEmail: string): Promise<APIGatewayProxyResult> {
  const callerIsAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!callerIsAdmin) return json(403, { ok: false, error: "Admin only" });

  const callerEmail = event.requestContext.authorizer?.userEmail as string;
  if (callerEmail === targetEmail) return json(400, { ok: false, error: "Cannot delete your own account" });

  const items = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `user#${targetEmail}` },
    ProjectionExpression: "pk, sk",
  }));
  const keys = (items.Items ?? []).map(k => ({ pk: k.pk as string, sk: k.sk as string }));
  // The owner's alias index items point at lookup items that live under their own pk.
  const aliasLookups = keys
    .filter(k => k.sk.startsWith("alias#"))
    .map(k => aliasKey(k.sk.slice("alias#".length)));
  await Promise.all([...aliasLookups, ...keys].map(key =>
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: key })),
  ));

  logger.info("User deleted", { targetEmail, by: callerEmail, aliases: aliasLookups.length });
  return json(200, { ok: true });
}

async function pushKey(): Promise<APIGatewayProxyResult> {
  const keys = await vapidKeys();
  if (!keys) return json(404, { ok: false, error: "Push notifications are not configured" });
  return json(200, { ok: true, data: { publicKey: keys.publicKey } });
}

async function pushSubscribe(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { email } = caller(event);
  const body = parseBody<PushSubscriptionRequest>(event.body);
  if (!body?.endpoint?.startsWith("https://") || !body.keys?.p256dh || !body.keys?.auth) {
    return json(400, { ok: false, error: "Invalid push subscription" });
  }

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `user#${email}`,
      sk: pushSk(body.endpoint),
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      createdAt: new Date().toISOString(),
    },
  }));
  return json(200, { ok: true });
}

async function pushUnsubscribe(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { email } = caller(event);
  const body = parseBody<{ endpoint: string }>(event.body);
  if (!body?.endpoint) return json(400, { ok: false, error: "endpoint required" });

  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `user#${email}`, sk: pushSk(body.endpoint) } }));
  return json(200, { ok: true });
}

// ─── Aliases ──────────────────────────────────────────────────────────────────

type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/**
 * Runs a write transaction. Returns null on success, or the `conflict` message
 * of the first item whose condition failed.
 */
async function transact(items: { item: TransactItem; conflict: string }[]): Promise<string | null> {
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items.map(i => i.item) }));
    return null;
  } catch (err) {
    if ((err as Error).name !== "TransactionCanceledException") throw err;
    const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    const i = reasons.findIndex(r => r.Code === "ConditionalCheckFailed");
    if (i === -1) throw err;
    return items[i].conflict;
  }
}

/** Writes that create an alias: both items, guarded against clashing with a user or another alias. */
function aliasWrites(alias: Alias): { item: TransactItem; conflict: string }[] {
  const taken = `${alias.address} is already taken`;
  return [
    { item: { ConditionCheck: { TableName: TABLE, Key: { pk: `user#${alias.address}`, sk: "profile" }, ConditionExpression: "attribute_not_exists(pk)" } }, conflict: taken },
    { item: { Put: { TableName: TABLE, Item: alias, ConditionExpression: "attribute_not_exists(pk)" } }, conflict: taken },
    { item: { Put: { TableName: TABLE, Item: { ...alias, ...ownerAliasKey(alias.owner, alias.address) } } }, conflict: taken },
  ];
}

/** Accepts a bare local part or a full address on this domain. */
function parseAliasAddress(input: string): { address: string } | { error: string } {
  const value = input.toLowerCase().trim();
  let localPart = value;
  if (value.includes("@")) {
    if (!value.endsWith(`@${DOMAIN}`)) return { error: `Aliases must be on ${DOMAIN}` };
    localPart = value.slice(0, -(DOMAIN.length + 1));
  }
  const error = aliasLocalPartError(localPart);
  return error ? { error } : { address: `${localPart}@${DOMAIN}` };
}

function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  return label.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LABEL_LENGTH) || undefined;
}

async function countAliases(owner: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `user#${owner}`, ":prefix": "alias#" },
      Select: "COUNT",
      ExclusiveStartKey: startKey,
    }));
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return count;
}

async function listAliases(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { email: callerEmail, isAdmin } = caller(event);
  const qs = event.queryStringParameters ?? {};
  const owner = qs.owner?.toLowerCase().trim() || callerEmail;
  if ((qs.all === "1" || owner !== callerEmail) && !isAdmin) return json(403, { ok: false, error: "Admin only" });

  const aliases: Alias[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = qs.all === "1"
      ? await ddb.send(new ScanCommand({
          TableName: TABLE,
          FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
          ExpressionAttributeValues: { ":prefix": "alias#", ":sk": "alias" },
          ExclusiveStartKey: startKey,
        }))
      : await ddb.send(new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `user#${owner}`, ":prefix": "alias#" },
          ExclusiveStartKey: startKey,
        }));
    aliases.push(...(res.Items ?? []) as Alias[]);
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  aliases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(200, { ok: true, data: aliases.map(toPublic) });
}

async function createAlias(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { email: callerEmail, isAdmin } = caller(event);
  const body = parseBody<CreateAliasRequest>(event.body) ?? {};
  const owner = body.owner?.toLowerCase().trim() || callerEmail;
  if (owner !== callerEmail && !isAdmin) return json(403, { ok: false, error: "You can only create aliases for yourself" });

  if (MAX_ALIASES_PER_USER && await countAliases(owner) >= MAX_ALIASES_PER_USER) {
    return json(400, { ok: false, error: `Users can have at most ${MAX_ALIASES_PER_USER} aliases` });
  }

  const requested = body.localPart?.trim();
  let parsedRequest: { address: string } | undefined;
  if (requested) {
    const parsed = parseAliasAddress(requested);
    if ("error" in parsed) return json(400, { ok: false, error: parsed.error });
    // Also keeps the transaction from touching user#<owner>/profile twice, which DynamoDB rejects.
    if (parsed.address === owner) return json(409, { ok: false, error: `${parsed.address} is already taken` });
    parsedRequest = parsed;
  }

  const label = cleanLabel(body.label);
  const attempts = parsedRequest ? 1 : GENERATE_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const address = parsedRequest?.address ?? `${generateAliasLocalPart()}@${DOMAIN}`;
    const alias: Alias = { ...aliasKey(address), address, owner, label, enabled: true, createdAt: new Date().toISOString() };
    const failed = await transact([
      { item: { ConditionCheck: { TableName: TABLE, Key: { pk: `user#${owner}`, sk: "profile" }, ConditionExpression: "attribute_exists(pk)" } }, conflict: "owner" },
      ...aliasWrites(alias),
    ]);
    if (!failed) {
      logger.info("Alias created", { address, owner, by: callerEmail });
      return json(201, { ok: true, data: toPublic(alias) });
    }
    if (failed === "owner") return json(404, { ok: false, error: "User not found" });
    if (parsedRequest) return json(409, { ok: false, error: failed });
  }
  return json(409, { ok: false, error: "Couldn't generate an unused name, try again" });
}

/** Loads an alias and checks the caller may change it. */
async function ownedAlias(event: APIGatewayProxyEvent, address: string): Promise<Alias | APIGatewayProxyResult> {
  const { email: callerEmail, isAdmin } = caller(event);
  const alias = await getAlias(ddb, TABLE, address);
  // Same 404 for missing and someone else's, so aliases can't be probed.
  if (!alias || (alias.owner !== callerEmail && !isAdmin)) return json(404, { ok: false, error: "Alias not found" });
  return alias;
}

async function updateAlias(event: APIGatewayProxyEvent, address: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<UpdateAliasRequest>(event.body);
  if (!body) return json(400, { ok: false, error: "Body required" });

  const alias = await ownedAlias(event, address);
  if ("statusCode" in alias) return alias;

  const sets: string[] = [];
  const removes: string[] = [];
  const values: Record<string, unknown> = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return json(400, { ok: false, error: "enabled must be true or false" });
    sets.push("enabled = :enabled");
    values[":enabled"] = body.enabled;
  }
  if (body.label !== undefined) {
    const label = cleanLabel(body.label);
    if (label) {
      sets.push("label = :label");
      values[":label"] = label;
    } else {
      removes.push("label");
    }
  }
  if (!sets.length && !removes.length) return json(400, { ok: false, error: "Nothing to update" });

  const expression = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].join(" ").trim();
  const update = (key: { pk: string; sk: string }): TransactItem => ({
    Update: {
      TableName: TABLE,
      Key: key,
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    },
  });
  const failed = await transact([
    { item: update(aliasKey(address)), conflict: "Alias not found" },
    { item: update(ownerAliasKey(alias.owner, address)), conflict: "Alias not found" },
  ]);
  if (failed) return json(404, { ok: false, error: failed });

  const updated: Alias = { ...alias, ...(body.enabled !== undefined && { enabled: body.enabled }) };
  if (body.label !== undefined) updated.label = cleanLabel(body.label);
  logger.info("Alias updated", { address, by: caller(event).email });
  return json(200, { ok: true, data: toPublic(updated) });
}

async function deleteAlias(event: APIGatewayProxyEvent, address: string): Promise<APIGatewayProxyResult> {
  const alias = await ownedAlias(event, address);
  if ("statusCode" in alias) return alias;

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: TABLE, Key: aliasKey(address) } },
      { Delete: { TableName: TABLE, Key: ownerAliasKey(alias.owner, address) } },
    ],
  }));
  logger.info("Alias deleted", { address, owner: alias.owner, by: caller(event).email });
  return json(200, { ok: true });
}
