import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { StoredEmail } from "@dork-mail/shared";
import type { Ctx } from "./context";
import { getItems } from "./email";
import { parseBlobId, uploadKey } from "./ids";

export type ResolvedBlob =
  | { kind: "s3"; key: string; type: string; size?: number; name?: string }
  | { kind: "inline"; content: string; type: string };

/** Finds a blob the caller's account may read. Every kind resolves through the caller's own keys. */
export async function resolveBlob(ctx: Ctx, blobId: string): Promise<ResolvedBlob | null> {
  const ref = parseBlobId(blobId);
  if (!ref) return null;

  if (ref.kind === "upload") {
    const key = uploadKey(ctx.accountId, ref.uploadId);
    try {
      const head = await ctx.s3.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
      return { kind: "s3", key, type: head.ContentType ?? "application/octet-stream", size: head.ContentLength };
    } catch {
      return null;
    }
  }

  const needsBody = ref.kind === "text" || ref.kind === "html";
  const item: StoredEmail | undefined = (await getItems(ctx, [ref.emailId], needsBody)).get(ref.emailId);
  if (!item) return null;

  switch (ref.kind) {
    case "raw":
      return item.rawKey ? { kind: "s3", key: item.rawKey, type: "message/rfc822", size: item.size } : null;
    case "text":
      return { kind: "inline", content: item.bodyText ?? "", type: "text/plain" };
    case "html":
      return item.bodyHtml === undefined ? null : { kind: "inline", content: item.bodyHtml, type: "text/html" };
    case "attachment": {
      const a = item.attachments?.[ref.index];
      return a ? { kind: "s3", key: a.s3Key, type: a.contentType, size: a.size, name: a.filename } : null;
    }
  }
}

export async function readBlob(ctx: Ctx, blob: ResolvedBlob): Promise<Buffer> {
  if (blob.kind === "inline") return Buffer.from(blob.content, "utf8");
  const obj = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: blob.key }));
  return Buffer.from(await obj.Body!.transformToByteArray());
}
