import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../storage/json-file.ts';
import { hashPassword, needsRehash, verifyPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.ts';

/**
 * Accounts and workspaces.
 *
 * A *workspace* is the unit of access control: it owns a drawing, a saved-project folder and a live
 * collaboration room. Every workspace has exactly one owner and any number of members, and every
 * request that touches a document resolves the workspace first and then checks membership. Sharing
 * is explicit — there is no path by which knowing a name grants access.
 *
 * The store is a JSON file. That is the right size for single-instance self-hosting, which is what
 * this project targets; the interface is narrow enough that swapping in a database later touches
 * this file and nothing else.
 */

export interface UserRecord {
  readonly id: string;
  /** Lower-cased, used for lookup and uniqueness. */
  readonly username: string;
  /** As typed at registration, used for display. */
  readonly displayName: string;
  passwordHash: string;
  readonly createdAt: string;
  lastSeenAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  name: string;
  readonly ownerId: string;
  memberIds: string[];
  readonly createdAt: string;
}

interface StoreShape {
  version: 1;
  users: UserRecord[];
  workspaces: WorkspaceRecord[];
}

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set(['admin', 'root', 'api', 'system', 'buildgraph', 'support', 'security']);

export interface WorkspaceAccess {
  readonly workspace: WorkspaceRecord;
  readonly role: 'owner' | 'member';
}

export class AccountStore {
  private readonly path: string;
  private data: StoreShape = { version: 1, users: [], workspaces: [] };

  private constructor(path: string) {
    this.path = path;
  }

  static async open(dataDir: string): Promise<AccountStore> {
    const store = new AccountStore(join(dataDir, 'accounts.json'));
    store.data = await readJsonFile<StoreShape>(store.path, { version: 1, users: [], workspaces: [] });
    store.data.users ??= [];
    store.data.workspaces ??= [];
    return store;
  }

  get userCount(): number {
    return this.data.users.length;
  }

  /* ---------------------------------------------------------------- users */

  async register(rawUsername: string, password: string): Promise<UserRecord> {
    const username = normaliseUsername(rawUsername);
    assertPasswordPolicy(password, username);
    if (this.findByUsername(username) !== undefined) {
      // Registration necessarily reveals that a name is taken; sign-in does not.
      throw conflict('That username is already taken');
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      username,
      displayName: rawUsername.trim().slice(0, 32),
      passwordHash: await hashPassword(password),
      createdAt: now,
      lastSeenAt: now,
    };
    this.data.users.push(user);
    this.createWorkspaceFor(user, `${user.displayName}'s workspace`);
    await this.persist();
    return user;
  }

  /**
   * Verify credentials. Returns null for both "no such user" and "wrong password", and burns a
   * comparable amount of CPU in the unknown-user case so that response time does not disclose
   * which accounts exist.
   */
  async authenticate(rawUsername: string, password: string): Promise<UserRecord | null> {
    const username = rawUsername.trim().toLowerCase();
    const user = this.findByUsername(username);
    if (user === undefined) {
      await verifyPassword(password, DECOY_HASH);
      return null;
    }
    if (!(await verifyPassword(password, user.passwordHash))) return null;

    if (needsRehash(user.passwordHash)) user.passwordHash = await hashPassword(password);
    user.lastSeenAt = new Date().toISOString();
    await this.persist();
    return user;
  }

  getUser(id: string): UserRecord | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  findByUsername(username: string): UserRecord | undefined {
    const key = username.trim().toLowerCase();
    return this.data.users.find((u) => u.username === key);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = this.getUser(userId);
    if (user === undefined) throw notFound('Account not found');
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
    assertPasswordPolicy(newPassword, user.username);
    user.passwordHash = await hashPassword(newPassword);
    await this.persist();
  }

  /* ----------------------------------------------------------- workspaces */

  /** Every workspace the user can open, owned first. */
  listWorkspaces(userId: string): WorkspaceAccess[] {
    return this.data.workspaces
      .filter((w) => w.ownerId === userId || w.memberIds.includes(userId))
      .map((workspace) => ({ workspace, role: workspace.ownerId === userId ? 'owner' as const : 'member' as const }))
      .sort((a, b) => (a.role === b.role ? a.workspace.name.localeCompare(b.workspace.name) : a.role === 'owner' ? -1 : 1));
  }

  /**
   * Resolve a workspace the user is allowed to open.
   *
   * "Does not exist" and "exists but is not yours" deliberately return the same 404. Distinguishing
   * them would turn this endpoint into an oracle for which workspace ids are real, which is exactly
   * the reconnaissance step before an access attempt.
   */
  access(userId: string, workspaceId: string): WorkspaceAccess {
    const workspace = this.data.workspaces.find((w) => w.id === workspaceId);
    if (workspace === undefined) throw notFound('Workspace not found');
    if (workspace.ownerId === userId) return { workspace, role: 'owner' };
    if (workspace.memberIds.includes(userId)) return { workspace, role: 'member' };
    throw notFound('Workspace not found');
  }

  /** The workspace a session lands in when none was requested. */
  defaultWorkspace(userId: string): WorkspaceRecord {
    const owned = this.data.workspaces.find((w) => w.ownerId === userId);
    if (owned !== undefined) return owned;
    const user = this.getUser(userId);
    if (user === undefined) throw notFound('Account not found');
    const created = this.createWorkspaceFor(user, `${user.displayName}'s workspace`);
    void this.persist();
    return created;
  }

  async createWorkspace(userId: string, name: string): Promise<WorkspaceRecord> {
    const user = this.getUser(userId);
    if (user === undefined) throw notFound('Account not found');
    if (this.data.workspaces.filter((w) => w.ownerId === userId).length >= 50) {
      throw badRequest('Workspace limit reached');
    }
    const workspace = this.createWorkspaceFor(user, name);
    await this.persist();
    return workspace;
  }

  async renameWorkspace(userId: string, workspaceId: string, name: string): Promise<WorkspaceRecord> {
    const { workspace, role } = this.access(userId, workspaceId);
    if (role !== 'owner') throw forbidden('Only the workspace owner can rename it');
    workspace.name = cleanWorkspaceName(name);
    await this.persist();
    return workspace;
  }

  async addMember(userId: string, workspaceId: string, memberUsername: string): Promise<WorkspaceRecord> {
    const { workspace, role } = this.access(userId, workspaceId);
    if (role !== 'owner') throw forbidden('Only the workspace owner can invite collaborators');

    const member = this.findByUsername(memberUsername);
    if (member === undefined) throw notFound('No account with that username');
    if (member.id === workspace.ownerId) throw badRequest('The owner already has access');
    if (workspace.memberIds.includes(member.id)) return workspace;
    if (workspace.memberIds.length >= 50) throw badRequest('Collaborator limit reached for this workspace');

    workspace.memberIds.push(member.id);
    await this.persist();
    return workspace;
  }

  async removeMember(userId: string, workspaceId: string, memberId: string): Promise<WorkspaceRecord> {
    const { workspace, role } = this.access(userId, workspaceId);
    // An owner can remove anyone; a member can remove themselves (leave).
    if (role !== 'owner' && memberId !== userId) throw forbidden('Only the workspace owner can remove collaborators');
    workspace.memberIds = workspace.memberIds.filter((id) => id !== memberId);
    await this.persist();
    return workspace;
  }

  /** Public view of a workspace: ids of members resolved to display names. */
  describe(workspace: WorkspaceRecord, viewerId: string): unknown {
    const owner = this.getUser(workspace.ownerId);
    return {
      id: workspace.id,
      name: workspace.name,
      role: workspace.ownerId === viewerId ? 'owner' : 'member',
      owner: owner ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null,
      members: workspace.memberIds
        .map((id) => this.getUser(id))
        .filter((u): u is UserRecord => u !== undefined)
        .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })),
      createdAt: workspace.createdAt,
    };
  }

  private createWorkspaceFor(user: UserRecord, name: string): WorkspaceRecord {
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: cleanWorkspaceName(name),
      ownerId: user.id,
      memberIds: [],
      createdAt: new Date().toISOString(),
    };
    this.data.workspaces.push(workspace);
    return workspace;
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.path, this.data);
  }
}

/**
 * A hash of a random value, compared against when the username is unknown. It makes the failed
 * sign-in path cost the same whether or not the account exists.
 */
const DECOY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function normaliseUsername(raw: string): string {
  const username = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw badRequest('Username must be 3–32 characters: lowercase letters, digits, hyphen or underscore, starting and ending with a letter or digit');
  }
  if (RESERVED_USERNAMES.has(username)) throw badRequest('That username is reserved');
  return username;
}

export function assertPasswordPolicy(password: string, username: string): void {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (value.length > MAX_PASSWORD_LENGTH) throw badRequest(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  if (value.toLowerCase().includes(username.toLowerCase())) throw badRequest('Password must not contain your username');
  if (/^(.)\1*$/.test(value)) throw badRequest('Password must not be a single repeated character');
}

export function cleanWorkspaceName(raw: unknown): string {
  const name = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 60);
  if (name.length === 0) throw badRequest('Workspace name cannot be empty');
  return name;
}
