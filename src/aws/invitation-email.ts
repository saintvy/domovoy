import { normalizeAppLocale, type AppLocale } from '../shared/locale';

export interface InvitationEmailInput {
  familyName: string;
  email: string;
  url: string;
}

export function invitationEmailLocale(value: unknown): AppLocale {
  return value === undefined ? 'ru' : normalizeAppLocale(value, 'en');
}

const copy = {
  ru: {
    subject: 'Домовой: приглашение в семью',
    eyebrow: 'Семейные финансы без сюрпризов',
    title: 'Вас пригласили в Домовой',
    intro: (family: string) => `Присоединяйтесь к семье «${family}».`,
    instruction: (email: string) =>
      `Войдите через Google с адресом ${email} и подтвердите приглашение.`,
    action: 'Принять приглашение',
    fallback: 'Если кнопка не работает, откройте эту ссылку:',
    expiry: 'Ссылка действует 7 дней и используется один раз.',
    ignore: 'Если вы не ожидали приглашения, просто проигнорируйте это письмо.',
  },
  en: {
    subject: 'Domovoy: family invitation',
    eyebrow: 'Household finances without surprises',
    title: 'You are invited to Domovoy',
    intro: (family: string) => `Join the “${family}” family.`,
    instruction: (email: string) =>
      `Sign in with Google using ${email}, then accept the invitation.`,
    action: 'Accept invitation',
    fallback: 'If the button does not work, open this link:',
    expiry: 'The link is valid for 7 days and can be used once.',
    ignore: 'If you were not expecting this invitation, ignore this email.',
  },
} as const;

export function escapeInvitationHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character]!,
  );
}

export function renderInvitationEmail(
  input: InvitationEmailInput,
  locale: AppLocale,
): { subject: string; text: string; html: string } {
  const strings = copy[locale];
  const text = `${strings.title}\n\n${strings.intro(input.familyName)}\n${strings.instruction(input.email)}\n\n${strings.action}:\n${input.url}\n\n${strings.expiry}\n${strings.ignore}`;
  const familyName = escapeInvitationHtml(input.familyName);
  const email = escapeInvitationHtml(input.email);
  const url = escapeInvitationHtml(input.url);
  const logoUrl = escapeInvitationHtml(
    new URL('/email-logo.png', input.url).toString(),
  );
  const html = `<!doctype html>
<html lang="${locale}">
<body style="margin:0;padding:0;background:#f3faf6;color:#172e25;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3faf6;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #d9eee3;border-radius:18px;">
        <tr><td style="padding:28px 32px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td align="center" valign="middle" width="48" height="48" style="width:48px;height:48px;"><img src="${logoUrl}" width="48" height="48" alt="Domovoy" style="display:block;width:48px;height:48px;border:0;border-radius:14px;"></td>
            <td style="padding-left:12px;color:#172e25;font-size:24px;font-weight:700;">Domovoy</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0 0 10px;color:#34735a;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">${strings.eyebrow}</p>
          <h1 style="margin:0 0 18px;color:#172e25;font-size:28px;line-height:1.25;">${strings.title}</h1>
          <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${strings.intro(familyName)}</p>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${strings.instruction(email)}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#207a55" style="border-radius:10px;">
            <a href="${url}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;">${strings.action}</a>
          </td></tr></table>
          <p style="margin:24px 0 6px;color:#49665a;font-size:13px;line-height:1.5;">${strings.fallback}</p>
          <p style="margin:0 0 20px;overflow-wrap:anywhere;font-size:13px;line-height:1.5;"><a href="${url}" style="color:#207a55;">${url}</a></p>
          <p style="margin:0;color:#49665a;font-size:13px;line-height:1.6;">${strings.expiry}<br>${strings.ignore}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: strings.subject, text, html };
}
