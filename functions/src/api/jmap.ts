/**
 * JMAP (RFC 8620, RFC 8621) for Bulwark and any other JMAP client.
 * GET  /.well-known/jmap                                  session resource
 * POST /jmap/api                                          method calls
 * GET  /jmap/download/{accountId}/{blobId}/{name}?type=   blob download
 * Uploads go straight to S3 through the REST API in terraform/upload.tf.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { caller } from "../lib/http";
import type { Ctx } from "../jmap/context";
import { MAX_CALLS_IN_REQUEST, dispatch, isRequest } from "../jmap/dispatch";
import { resolveBlob } from "../jmap/blobs";
import { accountIdFor } from "../jmap/ids";

const logger = new Logger({ serviceName: "api-jmap" });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const ses = new SESv2Client({});

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.EMAIL_BUCKET!;
const DOMAIN = process.env.MAIL_DOMAIN!.toLowerCase();
const ORIGIN = process.env.WEB_ORIGIN!;
const SES_CONFIG_SET = process.env.SES_CONFIG_SET || undefined;
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

// API Gateway caps request bodies at 10 MB, Lambda caps invocation payloads at 6 MB.
const MAX_SIZE_REQUEST = 5_000_000;
const MAX_SIZE_UPLOAD = 10_000_000;
// Leaves headroom under Lambda's 6 MB response cap for everything except body values.
const BODY_BUDGET_BYTES = 4_000_000;

const CAPABILITIES = {
  "urn:ietf:params:jmap:core": {
    maxSizeUpload: MAX_SIZE_UPLOAD,
    maxConcurrentUpload: 4,
    maxSizeRequest: MAX_SIZE_REQUEST,
    maxConcurrentRequests: 8,
    maxCallsInRequest: MAX_CALLS_IN_REQUEST,
    maxObjectsInGet: 500,
    maxObjectsInSet: 100,
    collationAlgorithms: [],
  },
  "urn:ietf:params:jmap:mail": {},
  "urn:ietf:params:jmap:submission": {},
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

const problem = (type: string, status: number, detail: string) =>
  respond(status, { type: `urn:ietf:params:jmap:error:${type}`, status, detail }, { "Content-Type": "application/problem+json" });

function context(email: string): Ctx {
  return {
    ddb, s3, ses,
    table: TABLE,
    bucket: BUCKET,
    domain: DOMAIN,
    sesConfigSet: SES_CONFIG_SET,
    sesMessageIdDomain: `${AWS_REGION === "us-east-1" ? "email" : AWS_REGION}.amazonses.com`,
    email,
    accountId: accountIdFor(email),
    createdIds: new Map(),
    bodyBudget: BODY_BUDGET_BYTES,
  };
}

function session(email: string) {
  const accountId = accountIdFor(email);
  return {
    capabilities: CAPABILITIES,
    accounts: {
      [accountId]: {
        name: email,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          "urn:ietf:params:jmap:mail": {
            maxMailboxesPerEmail: 1,
            maxMailboxDepth: 1,
            maxSizeMailboxName: 255,
            maxSizeAttachmentsPerEmail: 25 * 1024 * 1024,
            emailQuerySortOptions: ["receivedAt", "sentAt"],
            mayCreateTopLevelMailbox: false,
          },
          "urn:ietf:params:jmap:submission": { maxDelayedSend: 0, submissionExtensions: {} },
        },
      },
    },
    primaryAccounts: {
      "urn:ietf:params:jmap:mail": accountId,
      "urn:ietf:params:jmap:submission": accountId,
    },
    username: email,
    apiUrl: `${ORIGIN}/jmap/api`,
    downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${ORIGIN}/jmap/upload/{accountId}`,
    state: "1",
  };
}

async function api(event: APIGatewayProxyEvent, email: string): Promise<APIGatewayProxyResult> {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  if (Buffer.byteLength(raw) > MAX_SIZE_REQUEST) return problem("limit", 400, "Request too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("notJSON", 400, "Request body is not JSON");
  }
  if (!isRequest(body)) return problem("notRequest", 400, "Request does not match the JMAP Request type");
  if (body.methodCalls.length > MAX_CALLS_IN_REQUEST) return problem("limit", 400, "Too many method calls");

  const result = await dispatch(context(email), body, (err, method) => logger.error("Method failed", { method, error: err as Error }));
  return respond(200, { ...result, sessionState: "1" });
}

async function download(event: APIGatewayProxyEvent, email: string): Promise<APIGatewayProxyResult> {
  const match = event.path.match(/\/jmap\/download\/([^/]+)\/([^/]+)\/([^/]*)$/);
  if (!match) return problem("notFound", 404, "Not found");
  const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const [, accountId, blobId, encodedName] = match.map(safeDecode);
  const ctx = context(email);
  if (accountId !== ctx.accountId) return problem("notFound", 404, "Blob not found");

  const blob = await resolveBlob(ctx, blobId);
  if (!blob) return problem("notFound", 404, "Blob not found");

  const type = event.queryStringParameters?.type || blob.type;
  const name = encodedName || ("name" in blob && blob.name) || "download";
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

  if (blob.kind === "inline") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": `${type}; charset=utf-8`,
        "Content-Disposition": disposition,
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
      },
      body: blob.content,
    };
  }
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET,
    Key: blob.key,
    ResponseContentType: type,
    ResponseContentDisposition: disposition,
  }), { expiresIn: 300 });
  return { statusCode: 302, headers: { Location: url, "Cache-Control": "no-store" }, body: "" };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { email } = caller(event);
    if (event.httpMethod === "GET" && event.path === "/.well-known/jmap") return respond(200, session(email));
    if (event.httpMethod === "POST" && event.path === "/jmap/api") return await api(event, email);
    if (event.httpMethod === "GET" && event.path.startsWith("/jmap/download/")) return await download(event, email);
    return problem("notFound", 404, "Not found");
  } catch (err) {
    logger.error("Unhandled error", { error: err as Error, path: event.path, method: event.httpMethod });
    return problem("serverFail", 500, "Internal error");
  }
};
