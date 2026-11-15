import { MethodError, type Args, type Ctx, type MethodResponse } from "./context";
import { emailChanges, emailGet, searchSnippetGet, threadChanges, threadGet } from "./email";
import { mailboxChanges, mailboxGet, mailboxQuery, mailboxSet } from "./mailbox";
import { emailQuery, emailQueryChanges } from "./query";
import { emailSet } from "./set";
import {
  identityChanges, identityGet, identitySet, submissionChanges, submissionGet, submissionQuery, submissionSet,
} from "./submission";

type Method = (ctx: Ctx, args: Args, callId: string) => Promise<Args | MethodResponse[]>;

const METHODS: Record<string, Method> = {
  "Core/echo": async (_ctx, args) => args,
  "Mailbox/get": mailboxGet,
  "Mailbox/query": mailboxQuery,
  "Mailbox/changes": mailboxChanges,
  "Mailbox/set": mailboxSet,
  "Email/get": emailGet,
  "Email/query": emailQuery,
  "Email/queryChanges": emailQueryChanges,
  "Email/changes": emailChanges,
  "Email/set": emailSet,
  "Thread/get": threadGet,
  "Thread/changes": threadChanges,
  "SearchSnippet/get": searchSnippetGet,
  "Identity/get": identityGet,
  "Identity/changes": identityChanges,
  "Identity/set": identitySet,
  "EmailSubmission/set": submissionSet,
  "EmailSubmission/get": submissionGet,
  "EmailSubmission/query": submissionQuery,
  "EmailSubmission/changes": submissionChanges,
};

export const MAX_CALLS_IN_REQUEST = 32;

export interface JmapRequest {
  using: string[];
  methodCalls: [string, Args, string][];
  createdIds?: Record<string, string>;
}

export function isRequest(body: unknown): body is JmapRequest {
  const r = body as JmapRequest;
  return !!r && Array.isArray(r.using) && Array.isArray(r.methodCalls) && r.methodCalls.every(c =>
    Array.isArray(c) && c.length === 3 && typeof c[0] === "string" && !!c[1] && typeof c[1] === "object" && typeof c[2] === "string");
}

/** RFC 8620 section 3.7 JSON Pointer, where "*" maps over an array and flattens. */
function evaluatePointer(value: unknown, path: string): unknown {
  if (path === "" || path === "/") return value;
  const [head, ...rest] = path.replace(/^\//, "").split("/");
  const token = head.replace(/~1/g, "/").replace(/~0/g, "~");
  const remainder = rest.length ? "/" + rest.join("/") : "";
  if (token === "*") {
    if (!Array.isArray(value)) throw new MethodError("invalidResultReference", `${path} does not point at an array`);
    return value.flatMap(v => {
      const r = evaluatePointer(v, remainder);
      return Array.isArray(r) ? r : [r];
    });
  }
  if (value === null || typeof value !== "object" || !(token in value)) {
    throw new MethodError("invalidResultReference", `Nothing at ${path}`);
  }
  return evaluatePointer((value as Args)[token], remainder);
}

function resolveReferences(args: Args, responses: MethodResponse[]): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) { out[key] = value; continue; }
    const ref = value as { resultOf?: string; name?: string; path?: string };
    const source = responses.find(r => r[2] === ref.resultOf && r[0] === ref.name);
    if (!source || typeof ref.path !== "string") throw new MethodError("invalidResultReference", `No ${ref.name} result for ${ref.resultOf}`);
    out[key.slice(1)] = evaluatePointer(source[1], ref.path);
  }
  return out;
}

export async function dispatch(ctx: Ctx, request: JmapRequest, onServerFail: (err: unknown, method: string) => void): Promise<Args> {
  for (const [cid, id] of Object.entries(request.createdIds ?? {})) ctx.createdIds.set(cid, id);
  const responses: MethodResponse[] = [];
  for (const [name, rawArgs, callId] of request.methodCalls) {
    try {
      const method = METHODS[name];
      if (!method) throw new MethodError("unknownMethod", `${name} is not supported`);
      const args = resolveReferences(rawArgs, responses);
      if (args.accountId !== undefined && args.accountId !== ctx.accountId) throw new MethodError("accountNotFound");
      const result = await method(ctx, args, callId);
      if (Array.isArray(result)) responses.push(...result);
      else responses.push([name, result, callId]);
    } catch (err) {
      if (err instanceof MethodError) {
        responses.push(["error", { type: err.type, ...(err.message !== err.type ? { description: err.message } : {}) }, callId]);
      } else {
        onServerFail(err, name);
        responses.push(["error", { type: "serverFail" }, callId]);
      }
    }
  }
  return {
    methodResponses: responses,
    ...(request.createdIds ? { createdIds: Object.fromEntries(ctx.createdIds) } : {}),
  };
}
