import { createHash } from 'node:crypto';
import { exportState, type State } from '../domain';
import { encryptBackup } from '../server/security';
import { ApiError } from './identity';

/** Shared archive format for production S3 and development filesystem storage. */
export async function createBackupArchive(state: State, passphrase?: string) {
  const recovery = {
    format: 'brownie-recovery',
    version: 1,
    state: await exportState(state),
    revision: state.revision,
    exportedAt: new Date().toISOString(),
    notice: 'Google identities and sessions are not restored.',
  };
  const archive = passphrase
    ? await encryptBackup(recovery, passphrase)
    : recovery;
  const contents = JSON.stringify(archive);
  if (passphrase && Buffer.byteLength(contents) > 4 * 1024 * 1024)
    throw new ApiError('BACKUP_TOO_LARGE_USE_DATABASE_EXPORT', 413);
  const checksum = createHash('sha256').update(contents).digest('base64');
  return { archive: passphrase ? archive : undefined, contents, checksum };
}
