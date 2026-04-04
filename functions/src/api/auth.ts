/**
 * Auth API: login and create-user (admin only).
 * POST /auth/login
 * POST /auth/users  (admin)
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import type { User, AuthTokenPayload, ApiResponse } from "@dork-mail/shared";

const logger = new Logger({ serviceName: "api-auth" });
const tracer = new Tracer({ serviceName: "api-auth" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-auth" });

const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo);

const TABLE = process.env.TABLE_NAME!;
const JWT_PARAM = process.env.JWT_SECRET_PARAM!;
const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path;
  const method = event.httpMethod;

  if (method === "POST" && path.endsWith("/login")) {
    return login(event);
  }
  if (method === "POST" && path.endsWith("/users")) {
    return createUser(event);
  }

  return json(404, { ok: false, error: "Not found" });
};

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
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
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
  const token = jwt.sign(payload, secret);

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

  const body = parseBody<{ email: string; password: string; displayName: string }>(event.body);
  if (!body?.email || !body?.password || !body?.displayName) {
    return json(400, { ok: false, error: "email, password, displayName required" });
  }

  const email = body.email.toLowerCase().trim();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(body.password, 12);

  const user: User = {
    pk: `user#${email}`,
    sk: "profile",
    email,
    passwordHash,
    displayName: body.displayName,
    createdAt: now,
    isAdmin: false,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: user,
    ConditionExpression: "attribute_not_exists(pk)",
  }));

  logger.info("User created", { email });
  return json(201, { ok: true, data: { email, displayName: body.displayName } });
}

function parseBody<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function json(status: number, body: ApiResponse): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
