import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  generateToken,
  hashToken,
  verifyToken,
  withPathLock,
} from 'drone-swarm-common';

export interface TokenEntry {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  hash: string;
}

export type PublicTokenEntry = Omit<TokenEntry, 'hash'>;

export interface TokenStore {
  list(): PublicTokenEntry[];
  create(name: string): { entry: PublicTokenEntry; token: string };
  revoke(id: string): boolean;
  rename(id: string, name: string): PublicTokenEntry | undefined;
  verify(plain: string): PublicTokenEntry | undefined;
  flush(): Promise<void>;
}

const TOKEN_PREFIX = 'mcpsw_';
const LAST_USED_FLUSH_MS = 30_000;

interface TokenFile {
  version: number;
  tokens: TokenEntry[];
}

function toPublic(entry: TokenEntry): PublicTokenEntry {
  const pub: PublicTokenEntry = {
    id: entry.id,
    name: entry.name,
    createdAt: entry.createdAt,
  };
  if (entry.lastUsedAt !== undefined) pub.lastUsedAt = entry.lastUsedAt;
  return pub;
}

/**
 * Load the named-token store from `<dataDir>/tokens.json`. On a missing or
 * empty file it bootstraps a single `default` token, prints the plaintext once,
 * and writes it (mode 0600) to `<dataDir>/token`.
 *
 * In-memory state is the source of truth; every write goes through
 * `withPathLock` and a temp-file rename so concurrent calls cannot interleave.
 */
export async function loadTokenStore(
  dataDir: string,
  options: { log?: (message: string) => void } = {}
): Promise<TokenStore> {
  const filePath = path.join(dataDir, 'tokens.json');
  const bootstrapPath = path.join(dataDir, 'token');
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  await mkdir(dataDir, { recursive: true });

  let tokens: TokenEntry[] = [];
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as TokenFile;
    if (Array.isArray(parsed.tokens)) tokens = parsed.tokens;
  } catch {
    tokens = [];
  }

  const index = new Map<string, string>();
  for (const entry of tokens) index.set(entry.hash, entry.id);

  let lastUsedTimer: NodeJS.Timeout | null = null;

  const persist = async (): Promise<void> => {
    const payload: TokenFile = { version: 1, tokens };
    await withPathLock(filePath, async () => {
      const tmp = `${filePath}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      await rename(tmp, filePath);
      await chmod(filePath, 0o600);
    });
  };

  const schedulePersist = (): void => {
    void persist().catch(() => {
      // A background write failure is surfaced by the next explicit flush().
    });
  };

  const scheduleLastUsedFlush = (): void => {
    if (lastUsedTimer) return;
    lastUsedTimer = setTimeout(() => {
      lastUsedTimer = null;
      schedulePersist();
    }, LAST_USED_FLUSH_MS);
    lastUsedTimer.unref();
  };

  const mint = (name: string): { entry: TokenEntry; token: string } => {
    const token = generateToken(TOKEN_PREFIX);
    const entry: TokenEntry = {
      id: `t_${randomUUID()}`,
      name,
      createdAt: Date.now(),
      hash: hashToken(token),
    };
    tokens.push(entry);
    index.set(entry.hash, entry.id);
    return { entry, token };
  };

  if (tokens.length === 0) {
    const { entry, token } = mint('default');
    await persist();
    await writeFile(bootstrapPath, token, { mode: 0o600 });
    await chmod(bootstrapPath, 0o600);
    log(
      `mcp-swarm: created bootstrap token "${entry.name}" — ${token}\n` +
        `  Use it as "Authorization: Bearer <token>". It is stored at ${bootstrapPath} (mode 0600).`
    );
  }

  return {
    list() {
      return tokens.map(toPublic);
    },
    create(name) {
      const { entry, token } = mint(name);
      schedulePersist();
      return { entry: toPublic(entry), token };
    },
    revoke(id) {
      const position = tokens.findIndex(entry => entry.id === id);
      if (position === -1) return false;
      const [removed] = tokens.splice(position, 1);
      index.delete(removed.hash);
      schedulePersist();
      return true;
    },
    rename(id, name) {
      const entry = tokens.find(candidate => candidate.id === id);
      if (!entry) return undefined;
      entry.name = name;
      schedulePersist();
      return toPublic(entry);
    },
    verify(plain) {
      const id = index.get(hashToken(plain));
      if (!id) return undefined;
      const entry = tokens.find(candidate => candidate.id === id);
      if (!entry || !verifyToken(plain, entry.hash)) return undefined;
      entry.lastUsedAt = Date.now();
      scheduleLastUsedFlush();
      return toPublic(entry);
    },
    async flush() {
      if (lastUsedTimer) {
        clearTimeout(lastUsedTimer);
        lastUsedTimer = null;
      }
      await persist();
    },
  };
}
