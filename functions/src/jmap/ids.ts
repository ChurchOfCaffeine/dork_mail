const ID_CHARS = /^[A-Za-z0-9_-]{1,255}$/;

const encode = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const decode = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export const accountIdFor = (email: string) => encode(email);

/** Email ids are the item's sort key, so a lookup is a GetItem with no index. */
export const emailIdFor = (sk: string) => encode(sk);

export function skFor(emailId: string): string | null {
  if (!ID_CHARS.test(emailId)) return null;
  const sk = decode(emailId);
  return sk.startsWith("ts#") ? sk : null;
}

export type BlobRef =
  | { kind: "raw"; emailId: string }
  | { kind: "text"; emailId: string }
  | { kind: "html"; emailId: string }
  | { kind: "attachment"; emailId: string; index: number }
  | { kind: "upload"; uploadId: string };

export const rawBlobId = (emailId: string) => `R${emailId}`;
export const textBlobId = (emailId: string) => `T${emailId}`;
export const htmlBlobId = (emailId: string) => `H${emailId}`;
export const attachmentBlobId = (emailId: string, index: number) => `A${index}x${emailId}`;

/** Upload blobs are named after the API Gateway request id that stored them, see terraform/upload.tf. */
export const uploadKey = (accountId: string, uploadId: string) => `uploads/${accountId}/${uploadId}`;

export function parseBlobId(blobId: string): BlobRef | null {
  if (!ID_CHARS.test(blobId)) return null;
  const rest = blobId.slice(1);
  switch (blobId[0]) {
    case "R": return { kind: "raw", emailId: rest };
    case "T": return { kind: "text", emailId: rest };
    case "H": return { kind: "html", emailId: rest };
    case "U": return { kind: "upload", uploadId: rest };
    case "A": {
      const m = rest.match(/^(\d+)x(.+)$/);
      return m ? { kind: "attachment", index: Number(m[1]), emailId: m[2] } : null;
    }
    default: return null;
  }
}
