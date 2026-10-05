import type { ModuleSecretAccess, ModuleSecretReadAccess } from "../modules/contract";
import { authorizeModuleManagementMutation } from "./module-authorization";
import { decryptJson, encryptJson, getTokenEncryptionKeys, parseKeyRing, type TokenEncryptionEnvironment } from "./auth/crypto";

interface ModuleSecretEnvironment extends TokenEncryptionEnvironment {
  DB: D1Database;
}

interface ModuleSecretRow {
  ciphertext: string;
}

interface ModuleSecretPayload {
  channelId: string;
  moduleId: string;
  name: string;
  value: string;
}

const isModuleSecretPayload = (value: unknown): value is ModuleSecretPayload =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).channelId === "string" &&
  typeof (value as Record<string, unknown>).moduleId === "string" &&
  typeof (value as Record<string, unknown>).name === "string" &&
  typeof (value as Record<string, unknown>).value === "string";

/** Creates secret access bound to a single channel and module. */
export const createModuleSecretAccess = (
  environment: ModuleSecretEnvironment,
  channelId: string,
  moduleId: string,
): ModuleSecretAccess => {
  const encryptionKeys = () => parseKeyRing(getTokenEncryptionKeys(environment));

  const status: ModuleSecretAccess["status"] = async (name) => {
    const row = await environment.DB.prepare(
      `SELECT updated_at FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ?`,
    ).bind(channelId, moduleId, name).first<{ updated_at: string }>();
    return row === null ? { configured: false, updatedAt: null } : { configured: true, updatedAt: row.updated_at };
  };

  const readWithVersion: ModuleSecretAccess["readWithVersion"] = async (name) => {
    const row = await environment.DB.prepare(
      `SELECT ciphertext FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ?`,
    ).bind(channelId, moduleId, name).first<ModuleSecretRow>();
    if (row === null) return null;
    const payload: unknown = await decryptJson(row.ciphertext, encryptionKeys());
    if (!isModuleSecretPayload(payload) || payload.channelId !== channelId ||
        payload.moduleId !== moduleId || payload.name !== name) return null;
    return { value: payload.value, version: row.ciphertext };
  };
  const read: ModuleSecretAccess["read"] = async (name) => (await readWithVersion(name))?.value ?? null;

  const prepareWrite: ModuleSecretAccess["prepareWrite"] = async (name, value, actor, now) => {
    const keys = encryptionKeys();
    let ciphertext: string;
    try {
      ciphertext = await encryptJson({ channelId, moduleId, name, value }, keys);
    } catch {
      throw new Error("Module secret encryption failed.");
    }
    const authorization = authorizeModuleManagementMutation(channelId, actor, now);
    return environment.DB.prepare(
      `INSERT INTO module_secrets
        (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE 1 = 1 ${authorization.sql}
       ON CONFLICT (channel_id, module_id, name) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         key_id = excluded.key_id,
         revision = module_secrets.revision + 1,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).bind(channelId, moduleId, name, ciphertext, keys.active.id, now, actor.userId, ...authorization.values);
  };

  const prepareDelete: ModuleSecretAccess["prepareDelete"] = (name, actor, now) => {
    const authorization = authorizeModuleManagementMutation(channelId, actor, now);
    return environment.DB.prepare(
      `DELETE FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ? ${authorization.sql}`,
    ).bind(channelId, moduleId, name, ...authorization.values);
  };

  return { status, read, readWithVersion, prepareWrite, prepareDelete };
};

/** Creates a runtime read-only view for module template providers. */
export const createModuleSecretReadAccess = (
  environment: ModuleSecretEnvironment,
  channelId: string,
  moduleId: string,
): ModuleSecretReadAccess => {
  const access = createModuleSecretAccess(environment, channelId, moduleId);
  return { status: access.status, read: access.read };
};
