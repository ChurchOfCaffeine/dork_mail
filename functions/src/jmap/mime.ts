import MailComposer from "nodemailer/lib/mail-composer";
import type { EmailAddress, StoredEmail } from "@dork-mail/shared";

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  cid?: string;
}

const format = (a: EmailAddress) => ({ name: a.name ?? "", address: a.address });

/** Builds the raw message. Bcc stays out of the headers; SES takes it from the envelope. */
export function buildMime(e: StoredEmail, attachments: MimeAttachment[]): Promise<Buffer> {
  const composer = new MailComposer({
    from: format(e.from),
    to: e.to.map(format),
    cc: e.cc?.map(format),
    replyTo: e.replyTo?.map(format),
    subject: e.subject,
    date: new Date(e.receivedAt),
    messageId: `<${e.messageId}>`,
    inReplyTo: e.inReplyTo ? `<${e.inReplyTo}>` : undefined,
    references: e.references?.map(r => `<${r}>`),
    text: e.bodyText,
    html: e.bodyHtml,
    attachments: attachments.map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content, cid: a.cid })),
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
