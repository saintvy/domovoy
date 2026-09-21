import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3Backups } from './backups';
import { s3Rates } from './exchange-rates';
import type { FamilyServices } from './families';

let services: FamilyServices | undefined;
export function productionServices(): FamilyServices {
  if (services) return services;
  const s3 = new S3Client({ maxAttempts: 2 });
  const rates = process.env.SERVICES_BUCKET
    ? s3Rates(process.env.SERVICES_BUCKET, s3)
    : undefined;
  services = {
    appOrigin: process.env.APP_ORIGIN ?? '',
    backups: process.env.BACKUP_BUCKET
      ? (id) => new S3Backups(process.env.BACKUP_BUCKET!, id, s3)
      : undefined,
    quotes: rates
      ? (state, commands) => rates.quotes(state, commands)
      : undefined,
    sendInvitation:
      process.env.SERVICES_BUCKET && process.env.INVITATION_SENDER
        ? async (message) => {
            await s3.send(
              new PutObjectCommand({
                Bucket: process.env.SERVICES_BUCKET!,
                Key: `outbox/${message.id}.json`,
                Body: JSON.stringify(message),
                ContentType: 'application/json',
                ServerSideEncryption: 'AES256',
              }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
          }
        : undefined,
  };
  return services;
}
