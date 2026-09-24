import { describe, expect, it } from 'vitest';
import {
  invitationEmailLocale,
  renderInvitationEmail,
} from '../src/aws/invitation-email';

describe('localized invitation email', () => {
  it('renders English plaintext and email-compatible branded HTML', () => {
    const invitation = {
      familyName: 'Green Home',
      email: 'member@example.test',
      url: `https://domovoy.test/#invite=${'a'.repeat(43)}`,
    };
    const rendered = renderInvitationEmail(invitation, 'en');
    expect(rendered.subject).toBe('Domovoy: family invitation');
    expect(rendered.text).toContain('Join the “Green Home” family.');
    expect(rendered.text).toContain(invitation.url);
    expect(rendered.html).toContain('color:#172e25');
    expect(rendered.html).toContain('background:#f3faf6');
    expect(rendered.html).toContain('Accept invitation');
    expect(rendered.html).toContain(
      '<img src="https://domovoy.test/email-logo.png"',
    );
    expect(rendered.html).not.toMatch(/https?:\/\/(?!domovoy\.test)/);
  });

  it('escapes every dynamic HTML value while preserving the plaintext token fragment', () => {
    const token = 'b'.repeat(43);
    const url = `https://domovoy.test/#invite=${token}&source=email`;
    const rendered = renderInvitationEmail(
      {
        familyName: '<img src=x onerror="alert(1)">',
        email: 'member+<tag>@example.test',
        url,
      },
      'ru',
    );
    expect(rendered.text).toContain(url);
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).not.toContain('<tag>');
    expect(rendered.html).toContain(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(rendered.html).toContain('member+&lt;tag&gt;@example.test');
    expect(rendered.html).toContain(`#invite=${token}&amp;source=email`);
  });

  it('keeps locale-absent queued messages Russian and rejects unsupported tags to English', () => {
    expect(invitationEmailLocale(undefined)).toBe('ru');
    expect(invitationEmailLocale('ru-RU')).toBe('ru');
    expect(invitationEmailLocale('de-DE')).toBe('en');
    expect(
      renderInvitationEmail(
        {
          familyName: 'Дом',
          email: 'member@example.test',
          url: 'https://domovoy.test/#invite=old',
        },
        invitationEmailLocale(undefined),
      ).subject,
    ).toBe('Домовой: приглашение в семью');
  });
});
