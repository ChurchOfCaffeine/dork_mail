import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { Logger } from "@aws-lambda-powertools/logger";
import type { ApiResponse } from "@dork-mail/shared";

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? "";

export function json(status: number, body: ApiResponse): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": CORS_ORIGIN },
    body: JSON.stringify(body),
  };
}

export function parseBody<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function caller(event: APIGatewayProxyEvent): { email: string; isAdmin: boolean } {
  return {
    email: event.requestContext.authorizer?.userEmail as string,
    isAdmin: event.requestContext.authorizer?.isAdmin === "true",
  };
}

/** Turns unhandled errors into a JSON 500 that carries CORS headers, instead of API Gateway's bare 500. */
export function withErrors(
  logger: Logger,
  fn: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>,
): (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult> {
  return async (event) => {
    try {
      return await fn(event);
    } catch (err) {
      logger.error("Unhandled error", { error: err as Error, path: event.path, method: event.httpMethod });
      return json(500, { ok: false, error: "Internal error" });
    }
  };
}
