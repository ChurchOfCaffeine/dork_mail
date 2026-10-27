/**
 * Lambda authorizer for API Gateway.
 * Verifies the JWT from the Authorization header and returns an IAM policy.
 * The JWT secret is fetched from SSM Parameter Store via Powertools Parameters.
 */
import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import * as jwt from "jsonwebtoken";
import type { AuthTokenPayload } from "@dork-mail/shared";

const logger = new Logger({ serviceName: "authorizer" });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const JWT_PARAM = process.env.JWT_SECRET_PARAM!;
const TABLE = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  const token = extractToken(event.headers?.authorization ?? event.headers?.Authorization);

  if (!token) {
    logger.warn("No token provided");
    return deny(event.methodArn);
  }

  try {
    const secret = await getParameter(JWT_PARAM, { decrypt: true }) as string;
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as AuthTokenPayload;

    // The token outlives deletes and admin changes, so the current record decides.
    const user = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `user#${payload.sub}`, sk: "profile" },
      ProjectionExpression: "isAdmin",
    }));
    if (!user.Item) {
      logger.warn("Token for deleted user", { sub: payload.sub });
      return deny(event.methodArn);
    }

    logger.info("Authorized", { sub: payload.sub });

    return {
      principalId: payload.sub,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            // Allow all methods and routes for this API stage so the cached
            // policy isn't scoped to just the method of the first request.
            // methodArn: arn:aws:execute-api:region:account:api-id/stage/METHOD/path
            // We want: arn:aws:execute-api:region:account:api-id/stage/*
            Resource: event.methodArn.split("/").slice(0, 2).join("/") + "/*",
          },
        ],
      },
      context: {
        userEmail: payload.sub,
        isAdmin: String(user.Item.isAdmin === true),
      },
    };
  } catch (err) {
    logger.warn("Token verification failed", { error: (err as Error).message });
    return deny(event.methodArn);
  }
};

function extractToken(header?: string): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function deny(arn: string): APIGatewayAuthorizerResult {
  return {
    principalId: "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: arn }],
    },
  };
}
