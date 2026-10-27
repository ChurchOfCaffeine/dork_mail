import { createHash } from "node:crypto";
import type { Logger } from "@aws-lambda-powertools/logger";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import * as webpush from "web-push";
import type { StoredEmail } from "@dork-mail/shared";
import { countUnread } from "./mail-store";

const VAPID_PARAM = process.env.VAPID_PARAM ?? "";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "";

interface VapidKeys { publicKey: string; privateKey: string }

export async function vapidKeys(): Promise<VapidKeys | null> {
  if (!VAPID_PARAM) return null;
  const raw = await getParameter(VAPID_PARAM, { decrypt: true, maxAge: 300 });
  return raw ? JSON.parse(raw) as VapidKeys : null;
}

export const pushSk = (endpoint: string) => `push#${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}`;

/** Never throws: a failed push must not fail ingestion and trigger a redelivery. */
export async function notifyNewMail(
  ddb: DynamoDBDocumentClient,
  table: string,
  logger: Logger,
  mailbox: string,
  email: StoredEmail,
): Promise<void> {
  try {
    const keys = await vapidKeys();
    if (!keys) return;

    const subs = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `user#${mailbox}`, ":prefix": "push#" },
    }));
    if (!subs.Items?.length) return;

    const payload = JSON.stringify({
      title: email.from.name || email.from.address,
      body: (email.subject || "(no subject)").slice(0, 200),
      tag: email.messageId,
      url: `/mail?folder=inbox&m=${encodeURIComponent(email.messageId)}`,
      badge: await countUnread(ddb, table, mailbox, "inbox"),
    });

    await Promise.all(subs.Items.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { vapidDetails: { subject: WEB_ORIGIN, ...keys }, TTL: 86400, urgency: "normal" },
        );
      } catch (err) {
        const status = (err as webpush.WebPushError).statusCode;
        if (status === 404 || status === 410) {
          await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: sub.pk, sk: sub.sk } }));
          logger.info("Removed expired push subscription", { mailbox });
        } else {
          logger.warn("Push failed", { mailbox, status, error: (err as Error).message });
        }
      }
    }));
  } catch (err) {
    logger.warn("Push notification skipped", { mailbox, error: (err as Error).message });
  }
}
