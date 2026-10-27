/**
 * Auth API: login, user management, and push subscriptions.
 * POST   /auth/login
 * GET    /auth/users              (admin)
 * POST   /auth/users              (admin)
 * PATCH  /auth/users/:email       (admin or self)
 * DELETE /auth/users/:email       (admin)
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
} from "@aws-sdk/lib-dynamodb";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import isEmail from "validator/lib/isEmail";
import type { User, UserPublic, AuthTokenPayload, PushSubscriptionRequest } from "@dork-mail/shared";
import { json, parseBody, caller, withErrors } from "../lib/http";
import { vapidKeys, pushSk } from "../lib/push";

const logger = new Logger({ serviceName: "api-auth" });
const tracer = new Tracer({ serviceName: "api-auth" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-auth" });

const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo);

const TABLE = process.env.TABLE_NAME!;
const JWT_PARAM = process.env.JWT_SECRET_PARAM!;
const DOMAIN = process.env.MAIL_DOMAIN!.toLowerCase();
const JWT_TTL_SECONDS = 60 * 60 * 24; // 1 day
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

  logger.info("User created", { email });
  return json(201, { ok: true, data: { email, displayName: body.displayName } });
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
  await Promise.all((items.Items ?? []).map(key =>
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: key.pk, sk: key.sk } })),
  ));

  logger.info("User deleted", { targetEmail, by: callerEmail });
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
