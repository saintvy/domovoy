import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { type State } from '../domain';
import { createBackupArchive } from './backup-archive';
import { ApiError } from './identity';
import type { BackupService } from './application';

/** A private S3 bucket with encryption, versioning and retention is provisioned by IaC. */
export class S3Backups implements BackupService {
  constructor(
    private bucket: string,
    private instance: string,
    private s3 = new S3Client({ maxAttempts: 2 }),
  ) {}
  async save(state: State, passphrase?: string) {
    const { archive, contents, checksum } = await createBackupArchive(
      state,
      passphrase,
    );
    const key = `${this.prefix()}backups/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.json`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: contents,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        ChecksumSHA256: checksum,
      }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    const stored = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    const received = await stored.Body?.transformToString();
    if (
      received === undefined ||
      createHash('sha256').update(received).digest('base64') !== checksum
    )
      throw new ApiError('BACKUP_VERIFICATION_FAILED', 503);
    return {
      fileId: key,
      archive: passphrase ? archive : undefined,
      verified: true,
    };
  }
  private prefix() {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(this.instance))
      throw new ApiError('INVALID_STORAGE_PREFIX', 503);
    return 'family/' + this.instance + '/';
  }
  async purgeBatch() {
    const prefix = this.prefix();
    const listed = await this.s3.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 20,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    const objects = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ].map((object) => ({ Key: object.Key!, VersionId: object.VersionId! }));
    if (
      objects.some(
        (object) => !object.Key?.startsWith(prefix) || !object.VersionId,
      )
    )
      throw new ApiError('INVALID_STORAGE_INVENTORY', 503);
    if (objects.length) {
      const deleted = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (deleted.Errors?.length)
        throw new ApiError('STORAGE_DELETE_INCOMPLETE', 503);
    }
    const remaining = await this.s3.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    return {
      complete: !(
        remaining.Versions?.length ||
        remaining.DeleteMarkers?.length ||
        remaining.IsTruncated
      ),
    };
  }
  async remove(key: string) {
    if (!key.startsWith(this.prefix() + 'backups/'))
      throw new ApiError('INVALID_STORAGE_PREFIX', 503);
    const listed = await this.s3.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: key,
        MaxKeys: 20,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    const objects = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ]
      .filter((object) => object.Key === key)
      .map((object) => ({ Key: key, VersionId: object.VersionId! }));
    if (objects.length) {
      const deleted = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (deleted.Errors?.length || listed.IsTruncated)
        throw new ApiError('STORAGE_DELETE_INCOMPLETE', 503);
    }
  }
}
