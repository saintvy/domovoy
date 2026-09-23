import { describe, expect, it, vi } from 'vitest';
import { createTelegramWorker } from '../src/aws/telegram-worker';

const jobId = '11111111-1111-4111-8111-111111111111';
const key = `telegram-outbox/${jobId}.json`;
const notification = {
  Records: [{ s3: { bucket: { name: 'services' }, object: { key } } }],
};
function fixture() {
  const bridge = vi.fn(async (event: Record<string, unknown>): Promise<any> =>
    event.action === 'telegram.begin-delivery'
      ? { send: true, chatId: '123', text: '📅 К оплате: Test 10 EUR' }
      : { ok: true },
  );
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 99 } })),
  );
  const remove = vi.fn(async () => {});
  const secrets = vi.fn(async () => ({
    token: 'test-token',
    webhookSecret: 'webhook-secret',
  }));
  return {
    bridge,
    request,
    remove,
    secrets,
    worker: createTelegramWorker({
      bridge,
      fetch: request,
      remove,
      secrets,
      bucket: 'services',
    }),
  };
}
function webhook(body: unknown, secret = 'webhook-secret') {
  return {
    version: '2.0',
    rawPath: '/api/telegram/webhook',
    requestContext: { http: { method: 'POST' } },
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(body),
  };
}
const update = {
  update_id: 10,
  message: {
    text: `/start ${'a'.repeat(43)}`,
    from: { id: 123, username: 'example' },
    chat: { id: 123, type: 'private' },
  },
};

describe('Telegram worker delivery trust and failure boundaries', () => {
  it('claims before sending and records acceptance before deleting the wakeup', async () => {
    const f = fixture();
    await f.worker(notification);
    expect(f.bridge.mock.calls[0][0]).toMatchObject({
      action: 'telegram.begin-delivery',
      jobId,
    });
    expect(f.bridge.mock.invocationCallOrder[0]).toBeLessThan(
      f.request.mock.invocationCallOrder[0],
    );
    expect(f.bridge.mock.calls[1][0]).toMatchObject({
      action: 'telegram.finish-delivery',
      outcome: 'accepted',
      messageId: 99,
    });
    expect(f.remove).toHaveBeenCalledWith(key);
    expect(f.request.mock.calls[0][1]?.body).not.toContain('parse_mode');
  });
  it('does not send a duplicate or stale job refused by the bridge', async () => {
    const f = fixture();
    f.bridge.mockResolvedValue({ send: false });
    await f.worker(notification);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('records timeout as unknown without resending even if acknowledgement is lost', async () => {
    const f = fixture();
    f.request.mockRejectedValue(
      new Error('Sensitive provider URL must never escape'),
    );
    f.bridge.mockImplementation(async (event) => {
      if (event.action === 'telegram.begin-delivery')
        return { send: true, chatId: '123', text: 'Report' };
      if (f.bridge.mock.calls.length === 2)
        throw new Error('Acknowledgement lost');
      return { ok: true };
    });
    await f.worker(notification);
    expect(f.request).toHaveBeenCalledTimes(1);
    const finishes = f.bridge.mock.calls.slice(1).map(([event]) => event);
    expect(finishes).toHaveLength(2);
    expect(finishes[0]).toEqual(finishes[1]);
    expect(finishes[0]).toMatchObject({ outcome: 'unknown' });
  });
  it('retains wakeup on explicit throttling and stores the provider delay', async () => {
    const f = fixture();
    f.request.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 120 },
        }),
        { status: 429 },
      ),
    );
    await f.worker(notification);
    expect(f.bridge.mock.calls[1][0]).toMatchObject({
      outcome: 'retryable',
      retryAfterSeconds: 120,
    });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not discard a wakeup when the bridge rejects the acknowledgement', async () => {
    const f = fixture();
    f.bridge.mockImplementation(async (event) =>
      event.action === 'telegram.begin-delivery'
        ? { send: true, chatId: '123', text: 'Report' }
        : { ok: false },
    );
    await expect(f.worker(notification)).rejects.toThrow(
      'TELEGRAM_ACKNOWLEDGEMENT_FAILED',
    );
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('treats ambiguous server errors as unknown and blocked chats as failed', async () => {
    for (const [code, outcome] of [
      [500, 'unknown'],
      [403, 'failed'],
    ] as const) {
      const f = fixture();
      f.request.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error_code: code }), {
          status: code,
        }),
      );
      await f.worker(notification);
      expect(f.bridge.mock.calls[1][0]).toMatchObject({ outcome });
    }
  });
  it('missing secrets do not consume an attempt and foreign buckets cannot send', async () => {
    const f = fixture();
    f.secrets.mockRejectedValue(new Error('Missing parameter'));
    await expect(f.worker(notification)).rejects.toThrow();
    expect(f.bridge).not.toHaveBeenCalled();
    await f.worker({
      Records: [{ s3: { bucket: { name: 'foreign' }, object: { key } } }],
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('requires provider secret before consuming any private-chat token', async () => {
    const f = fixture();
    expect(await f.worker(webhook(update, 'wrong'))).toMatchObject({
      statusCode: 403,
    });
    expect(f.bridge).not.toHaveBeenCalled();
    expect(await f.worker(webhook(update))).toMatchObject({ statusCode: 200 });
    expect(f.bridge).toHaveBeenCalledWith({
      action: 'telegram.consume-link',
      updateId: 10,
      token: 'a'.repeat(43),
      telegramUserId: '123',
      chatId: '123',
      username: 'example',
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('ignores groups and mismatched sender identity, bounds payloads, retries bridge failure', async () => {
    const f = fixture();
    for (const chat of [
      { id: 123, type: 'group' },
      { id: 456, type: 'private' },
    ])
      await f.worker(
        webhook({ ...update, message: { ...update.message, chat } }),
      );
    expect(f.bridge).not.toHaveBeenCalled();
    expect(await f.worker(webhook('x'.repeat(100000)))).toMatchObject({
      statusCode: 413,
    });
    f.bridge.mockRejectedValue(new Error('SQL unavailable'));
    expect(await f.worker(webhook(update))).toMatchObject({ statusCode: 503 });
  });
});
