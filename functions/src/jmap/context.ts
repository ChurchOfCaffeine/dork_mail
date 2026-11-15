import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SESv2Client } from "@aws-sdk/client-sesv2";

export interface Ctx {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  ses: SESv2Client;
  table: string;
  bucket: string;
  domain: string;
  sesConfigSet?: string;
  sesMessageIdDomain: string;
  email: string;
  accountId: string;
  /** Creation id to server id, across the calls of one request (RFC 8620 section 5.3). */
  createdIds: Map<string, string>;
  /** Body value bytes this response may still carry under Lambda's 6 MB response cap. */
  bodyBudget: number;
}

export type Args = Record<string, unknown>;
export type MethodResponse = [string, Args, string];

export class MethodError extends Error {
  constructor(readonly type: string, description?: string) {
    super(description ?? type);
  }
}

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export function setError(type: string, description?: string, properties?: string[]): SetError {
  return { type, ...(description ? { description } : {}), ...(properties ? { properties } : {}) };
}

export function stringArg(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new MethodError("invalidArguments", `${name} must be a string`);
  return v;
}

export function idsArg(args: Args, name: string, max: number): string[] | null {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every(id => typeof id === "string")) {
    throw new MethodError("invalidArguments", `${name} must be a list of ids`);
  }
  if (v.length > max) throw new MethodError("requestTooLarge", `At most ${max} ids per call`);
  return v;
}

/** Resolves "#creationId" references from earlier calls in the same request. */
export function resolveId(ctx: Ctx, id: string): string {
  return id.startsWith("#") ? (ctx.createdIds.get(id.slice(1)) ?? id) : id;
}

export const toUtcDate = (iso: string) => new Date(iso).toISOString().replace(/\.000Z$/, "Z");
