import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Alias, AliasPublic } from "@dork-mail/shared";

/** Lookup item, read by ingest and send to resolve an address. */
export const aliasKey = (address: string) => ({ pk: `alias#${address}`, sk: "alias" });
/** Index item under the owner, queried to list a user's aliases. */
export const ownerAliasKey = (owner: string, address: string) => ({ pk: `user#${owner}`, sk: `alias#${address}` });

export function toPublic(a: Alias): AliasPublic {
  const { pk, sk, ...rest } = a;
  return rest;
}

export async function getAlias(ddb: DynamoDBDocumentClient, table: string, address: string): Promise<Alias | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: aliasKey(address) }));
  return res.Item as Alias | undefined;
}
