/**
 * DNS / Setup Wizard API — admin only.
 * GET  /api/dns/check                        — reads Route 53 zone, returns DNS record status
 * POST /api/dns/apply                        — writes missing/incorrect records to Route 53
 * GET  /api/dns/ses-status                   — SES domain verification, DKIM, sandbox/review status
 * POST /api/dns/ses-verify                   — triggers SES domain verification re-check
 * GET  /api/dns/verified-emails              — list SES verified email identities (sandbox testing)
 * POST /api/dns/verified-emails              — send verification email to an address
 * DELETE /api/dns/verified-emails/{email}    — remove a verified email identity
 * POST /api/dns/request-production-access    — submit SES production access request via SESv2
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  Route53Client,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import {
  SESClient,
  GetIdentityVerificationAttributesCommand,
  GetIdentityDkimAttributesCommand,
  VerifyDomainIdentityCommand,
  VerifyDomainDkimCommand,
  VerifyEmailIdentityCommand,
  ListIdentitiesCommand,
  DeleteIdentityCommand,
  GetSendQuotaCommand,
  IdentityType,
} from "@aws-sdk/client-ses";
import {
  SESv2Client,
  GetAccountCommand,
  PutAccountDetailsCommand,
  MailType,
  ContactLanguage,
} from "@aws-sdk/client-sesv2";
import type { DnsCheckResult, DnsRecord, DkimRecord, ApiResponse } from "@dork-mail/shared";

const logger = new Logger({ serviceName: "api-dns" });
const tracer = new Tracer({ serviceName: "api-dns" });

const r53   = tracer.captureAWSv3Client(new Route53Client({}));
const ses   = tracer.captureAWSv3Client(new SESClient({}));
const sesv2 = tracer.captureAWSv3Client(new SESv2Client({}));

const DOMAIN = process.env.MAIL_DOMAIN!;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const SES_INBOUND_ENDPOINT = process.env.SES_INBOUND_ENDPOINT!;
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const CORS_ORIGIN = process.env.WEB_ORIGIN ?? "";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const isAdmin = event.requestContext.authorizer?.isAdmin === "true";
  if (!isAdmin) return json(403, { ok: false, error: "Admin only" });

  const path = event.path;
  const method = event.httpMethod;

  if (method === "GET"    && path.endsWith("/check"))                    return checkDns();
  if (method === "POST"   && path.endsWith("/apply"))                    return applyDns(event);
  if (method === "GET"    && path.endsWith("/ses-status"))               return sesStatus();
  if (method === "POST"   && path.endsWith("/ses-verify"))               return sesVerify();
  if (method === "GET"    && path.endsWith("/verified-emails"))          return listVerifiedEmails();
  if (method === "POST"   && path.endsWith("/verified-emails"))          return addVerifiedEmail(event);
  if (method === "DELETE" && path.includes("/verified-emails/"))         return removeVerifiedEmail(path);
  if (method === "POST"   && path.endsWith("/request-production-access")) return requestProductionAccess(event);

  return json(404, { ok: false, error: "Not found" });
};

// ─── DNS Check ────────────────────────────────────────────────────────────────

async function checkDns(): Promise<APIGatewayProxyResult> {
  const records = await getAllRecords();

  const mx = checkMx(records);
  const spf = checkSpf(records);
  const dkim = await checkDkim(records);
  const dmarc = checkDmarc(records);
  const mailFromMx = checkMailFromMx(records);
  const mailFromSpf = checkMailFromSpf(records);

  const sesVer = await getSesVerification();
  const sesVerified = sesVer === "Success";

  const issues: DnsRecord[] = [];

  if (!mx.some(r => r.present && r.correct)) {
    issues.push({
      type: "MX", name: `${DOMAIN}.`,
      value: `10 ${SES_INBOUND_ENDPOINT}.`,
      ttl: 300, present: false, correct: false,
    });
  }
  if (!spf || !spf.correct) {
    issues.push({
      type: "TXT", name: `${DOMAIN}.`,
      value: '"v=spf1 include:amazonses.com ~all"',
      ttl: 300, present: !!spf?.present, correct: false,
    });
  }
  if (!dmarc || !dmarc.correct) {
    issues.push({
      type: "TXT", name: `_dmarc.${DOMAIN}.`,
      value: `"v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}"`,
      ttl: 300, present: !!dmarc?.present, correct: false,
    });
  }
  if (!mailFromMx || !mailFromMx.correct) {
    issues.push({
      type: "MX", name: `bounces.${DOMAIN}.`,
      value: `10 feedback-smtp.${AWS_REGION}.amazonses.com`,
      ttl: 300, present: !!mailFromMx?.present, correct: false,
    });
  }
  if (!mailFromSpf || !mailFromSpf.correct) {
    issues.push({
      type: "TXT", name: `bounces.${DOMAIN}.`,
      value: '"v=spf1 include:amazonses.com ~all"',
      ttl: 300, present: !!mailFromSpf?.present, correct: false,
    });
  }

  const result: DnsCheckResult = { domain: DOMAIN, mx, spf, dkim, dmarc, mailFromMx, mailFromSpf, issues, sesVerified };
  return json(200, { ok: true, data: result });
}

// ─── DNS Apply ────────────────────────────────────────────────────────────────

async function applyDns(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ records: DnsRecord[] }>(event.body);
  if (!body?.records?.length) return json(400, { ok: false, error: "records array required" });

  const changes = body.records.map(r => ({
    Action: "UPSERT" as const,
    ResourceRecordSet: {
      Name: r.name,
      Type: r.type as any,
      TTL: r.ttl ?? 300,
      ResourceRecords: [{ Value: r.value }],
    },
  }));

  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: HOSTED_ZONE_ID,
    ChangeBatch: { Changes: changes },
  }));

  logger.info("Applied DNS records", { count: changes.length });
  return json(200, { ok: true, data: { applied: changes.length } });
}

// ─── SES Status ───────────────────────────────────────────────────────────────

async function sesStatus(): Promise<APIGatewayProxyResult> {
  const [verStatus, dkimAttrs, quota, account] = await Promise.all([
    getSesVerification(),
    getSesDkim(),
    ses.send(new GetSendQuotaCommand({})),
    sesv2.send(new GetAccountCommand({})).catch(() => null),
  ]);

  // Sandbox accounts are capped at 200 emails/day and 1/sec send rate
  const inSandbox = quota.Max24HourSend === 200 && quota.MaxSendRate === 1;

  const review = account?.Details?.ReviewDetails ?? null;

  return json(200, {
    ok: true,
    data: {
      verificationStatus: verStatus,
      dkim: dkimAttrs,
      inSandbox,
      quota: {
        max24Hour: quota.Max24HourSend,
        maxSendRate: quota.MaxSendRate,
        sentLast24Hours: quota.SentLast24Hours,
      },
      productionReview: review ? {
        status: review.Status ?? "UNKNOWN",
        caseId: review.CaseId,
      } : null,
    },
  });
}

async function requestProductionAccess(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ websiteUrl: string; useCaseDescription: string }>(event.body);
  if (!body?.websiteUrl || !body.useCaseDescription) {
    return json(400, { ok: false, error: "websiteUrl and useCaseDescription required" });
  }

  await sesv2.send(new PutAccountDetailsCommand({
    MailType: MailType.TRANSACTIONAL,
    WebsiteURL: body.websiteUrl,
    UseCaseDescription: body.useCaseDescription,
    ContactLanguage: ContactLanguage.EN,
    ProductionAccessEnabled: true,
  }));

  logger.info("Production access requested");
  return json(200, { ok: true, data: { message: "Production access request submitted. AWS will review within 24–48 hours." } });
}

async function sesVerify(): Promise<APIGatewayProxyResult> {
  const [verRes, dkimRes] = await Promise.all([
    ses.send(new VerifyDomainIdentityCommand({ Domain: DOMAIN })),
    ses.send(new VerifyDomainDkimCommand({ Domain: DOMAIN })),
  ]);

  return json(200, {
    ok: true,
    data: {
      verificationToken: verRes.VerificationToken,
      dkimTokens: dkimRes.DkimTokens,
    },
  });
}

// ─── Verified Emails (sandbox testing) ───────────────────────────────────────

async function listVerifiedEmails(): Promise<APIGatewayProxyResult> {
  const res = await ses.send(new ListIdentitiesCommand({ IdentityType: IdentityType.EmailAddress }));
  const emails = res.Identities ?? [];

  // Get verification status for all at once
  if (!emails.length) return json(200, { ok: true, data: [] });

  const attrs = await ses.send(new GetIdentityVerificationAttributesCommand({ Identities: emails }));
  const list = emails.map(email => ({
    email,
    status: attrs.VerificationAttributes?.[email]?.VerificationStatus ?? "Pending",
  }));

  return json(200, { ok: true, data: list });
}

async function addVerifiedEmail(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ email: string }>(event.body);
  if (!body?.email) return json(400, { ok: false, error: "email required" });

  await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: body.email }));
  logger.info("Verification email sent", { email: body.email });

  return json(200, { ok: true, data: { message: `Verification email sent to ${body.email}` } });
}

async function removeVerifiedEmail(path: string): Promise<APIGatewayProxyResult> {
  const email = decodeURIComponent(path.split("/verified-emails/")[1]);
  if (!email) return json(400, { ok: false, error: "email required" });

  await ses.send(new DeleteIdentityCommand({ Identity: email }));
  return json(200, { ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAllRecords(): Promise<ResourceRecordSet[]> {
  const all: ResourceRecordSet[] = [];
  let nextToken: string | undefined;
  do {
    const res = await r53.send(new ListResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      StartRecordIdentifier: nextToken,
    }));
    all.push(...(res.ResourceRecordSets ?? []));
    nextToken = res.NextRecordIdentifier;
  } while (nextToken);
  return all;
}

function checkMx(records: ResourceRecordSet[]): DnsRecord[] {
  const mxRecords = records.filter(r => r.Type === "MX" && r.Name === `${DOMAIN}.`);
  return mxRecords.map(r => {
    const value = r.ResourceRecords?.[0]?.Value ?? "";
    const correct = value.toLowerCase().includes(SES_INBOUND_ENDPOINT.toLowerCase());
    return { type: "MX", name: r.Name!, value, ttl: r.TTL, present: true, correct };
  });
}

function checkSpf(records: ResourceRecordSet[]): DnsRecord | null {
  const txt = records.find(
    r => r.Type === "TXT" && r.Name === `${DOMAIN}.` &&
      r.ResourceRecords?.some(rr => rr.Value?.includes("v=spf1"))
  );
  if (!txt) return null;
  const value = txt.ResourceRecords![0].Value!;
  return { type: "TXT", name: txt.Name!, value, ttl: txt.TTL, present: true, correct: value.includes("include:amazonses.com") };
}

async function checkDkim(records: ResourceRecordSet[]): Promise<DkimRecord[]> {
  const dkimAttrs = await getSesDkim();
  const tokens: string[] = dkimAttrs?.DkimTokens ?? [];
  return tokens.map(token => {
    const cname = `${token}._domainkey.${DOMAIN}.`;
    const target = `${token}.dkim.amazonses.com`;
    const existing = records.find(r => r.Type === "CNAME" && r.Name === cname);
    return { type: "CNAME", name: cname, value: target, present: !!existing, correct: existing?.ResourceRecords?.[0]?.Value === target, selector: token };
  });
}

function checkMailFromMx(records: ResourceRecordSet[]): DnsRecord | null {
  const rec = records.find(r => r.Type === "MX" && r.Name === `bounces.${DOMAIN}.`);
  if (!rec) return null;
  const value = rec.ResourceRecords?.[0]?.Value ?? "";
  return { type: "MX", name: rec.Name!, value, ttl: rec.TTL, present: true, correct: value.toLowerCase().includes("feedback-smtp") && value.toLowerCase().includes("amazonses.com") };
}

function checkMailFromSpf(records: ResourceRecordSet[]): DnsRecord | null {
  const rec = records.find(
    r => r.Type === "TXT" && r.Name === `bounces.${DOMAIN}.` &&
      r.ResourceRecords?.some(rr => rr.Value?.includes("v=spf1"))
  );
  if (!rec) return null;
  const value = rec.ResourceRecords![0].Value!;
  return { type: "TXT", name: rec.Name!, value, ttl: rec.TTL, present: true, correct: value.includes("include:amazonses.com") };
}

function checkDmarc(records: ResourceRecordSet[]): DnsRecord | null {
  const rec = records.find(r => r.Type === "TXT" && r.Name === `_dmarc.${DOMAIN}.`);
  if (!rec) return null;
  const value = rec.ResourceRecords?.[0]?.Value ?? "";
  return { type: "TXT", name: rec.Name!, value, ttl: rec.TTL, present: true, correct: value.includes("v=DMARC1") };
}

async function getSesVerification(): Promise<string> {
  const res = await ses.send(new GetIdentityVerificationAttributesCommand({ Identities: [DOMAIN] }));
  return res.VerificationAttributes?.[DOMAIN]?.VerificationStatus ?? "NotStarted";
}

async function getSesDkim(): Promise<any> {
  const res = await ses.send(new GetIdentityDkimAttributesCommand({ Identities: [DOMAIN] }));
  return res.DkimAttributes?.[DOMAIN];
}

function parseBody<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function json(status: number, body: ApiResponse): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": CORS_ORIGIN },
    body: JSON.stringify(body),
  };
}
