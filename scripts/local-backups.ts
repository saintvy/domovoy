import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  unlink,
  rename,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import type { State } from '../src/domain';
import type { BackupService } from '../src/aws/application';
import { createBackupArchive } from '../src/aws/backup-archive';
import { ApiError } from '../src/aws/identity';

const managedName =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json(?:\.pending)?$/;
const prefix = 'local/backups/';

/** Development only. No AWS SDK, credentials or cloud endpoints. */
export class LocalBackups implements BackupService {
  constructor(private directory: string) {}

  async save(state: State, passphrase?: string) {
    const { archive, contents, checksum } = await createBackupArchive(
      state,
      passphrase,
    );
    await mkdir(this.directory, { recursive: true });
    const name = `${randomUUID()}.json`;
    const target = resolve(this.directory, name);
    const temporary = target + '.pending';
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
    const stored = await readFile(target);
    if (createHash('sha256').update(stored).digest('base64') !== checksum)
      throw new ApiError('BACKUP_VERIFICATION_FAILED', 503);
    return { fileId: prefix + name, archive, verified: true };
  }

  private async inventory() {
    await mkdir(this.directory, { recursive: true });
    return (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && managedName.test(entry.name))
      .map((entry) => entry.name);
  }

  async remove(key: string) {
    const name = key.slice(prefix.length);
    if (!key.startsWith(prefix) || !managedName.test(name))
      throw new ApiError('INVALID_STORAGE_PREFIX', 503);
    try {
      await unlink(resolve(this.directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async purgeBatch() {
    for (const name of (await this.inventory()).slice(0, 20))
      await this.remove(prefix + name);
    return { complete: (await this.inventory()).length === 0 };
  }
}
