declare module "nodemailer/lib/mail-composer" {
  interface Address {
    name: string;
    address: string;
  }
  interface MailOptions {
    from?: Address;
    to?: Address[];
    cc?: Address[];
    replyTo?: Address[];
    subject?: string;
    date?: Date;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    text?: string;
    html?: string;
    attachments?: { filename: string; contentType: string; content: Buffer; cid?: string }[];
  }
  interface MimeNode {
    build(callback: (err: Error | null, message: Buffer) => void): void;
  }
  export default class MailComposer {
    constructor(mail: MailOptions);
    compile(): MimeNode;
  }
}
