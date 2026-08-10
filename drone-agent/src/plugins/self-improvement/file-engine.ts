import { mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  DroneInsightEntry,
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DronePrincipleEntry,
  DronePrincipleStorageEngine,
  DroneSkillsCapability,
} from 'drone-core';
import { CONFIG_DIR, INSIGHTS_SUBDIR, PRINCIPLES_SUBDIR } from './constants.js';
import { resolveBaseDir } from './validation.js';
import { resolveInsightPaths, resolvePrinciplePaths } from './paths.js';
import {
  readJsonArray,
  scanJsonDir,
  withFileLock,
  writeJsonArrayAtomic,
} from './io.js';

/**
 * Create a file-based insight storage engine. This is the default for
 * local-scoped targets (project/user). It reads/writes JSON files in
 * .drone-agent/insights/ and .drone-agent/principles/.
 */
export function createFileInsightEngine(
  providerId: string,
  projectDir: string,
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined
): DroneInsightStorageEngine {
  return {
    providerId,
    recordInsight: async (targetType, targetId, insight) => {
      const baseDir = resolveBaseDir(
        targetType,
        targetId,
        projectDir,
        personaCap(),
        skillsCap()
      );
      const { insightsDir, filePath } = resolveInsightPaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
      await mkdir(insightsDir, { recursive: true });
      return withFileLock(filePath, async () => {
        const entries = await readJsonArray<DroneInsightEntry>(filePath);
        entries.push({ timestamp: new Date().toISOString(), insight });
        await writeJsonArrayAtomic(filePath, entries);
        return { ok: true, entryCount: entries.length };
      });
    },
    listInsights: async (targetType, targetId) => {
      const results: Array<{
        targetType: string;
        targetId: string;
        entryCount: number;
        lastTimestamp?: string;
      }> = [];

      if (targetType === 'persona') {
        const personasDir = path.join(projectDir, CONFIG_DIR, 'personas');
        try {
          const personaDirs = await readdir(personasDir);
          for (const pid of personaDirs) {
            if (targetId && pid !== targetId) continue;
            const insightsDir = path.join(personasDir, pid, INSIGHTS_SUBDIR);
            const files = await scanJsonDir<DroneInsightEntry>(insightsDir);
            for (const f of files) {
              results.push({
                targetType: 'persona',
                targetId: f.id === 'insights' ? pid : `${pid}/${f.id}`,
                entryCount: f.entryCount,
                lastTimestamp: f.lastTimestamp,
              });
            }
          }
        } catch {
          // No personas directory
        }
      } else {
        const dir = path.join(
          projectDir,
          CONFIG_DIR,
          INSIGHTS_SUBDIR,
          targetType
        );
        const files = await scanJsonDir<DroneInsightEntry>(dir);
        for (const f of files) {
          if (targetId && f.id !== targetId) continue;
          results.push({
            targetType,
            targetId: f.id,
            entryCount: f.entryCount,
            lastTimestamp: f.lastTimestamp,
          });
        }
      }

      return results;
    },
    readInsights: async (targetType, targetId) => {
      const baseDir = resolveBaseDir(
        targetType,
        targetId,
        projectDir,
        personaCap(),
        skillsCap()
      );
      const { filePath } = resolveInsightPaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
      return readJsonArray<DroneInsightEntry>(filePath);
    },
  };
}

export function createFilePrincipleEngine(
  providerId: string,
  projectDir: string,
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined
): DronePrincipleStorageEngine {
  return {
    providerId,
    storePrinciple: async (targetType, targetId, principle, source) => {
      const baseDir = resolveBaseDir(
        targetType,
        targetId,
        projectDir,
        personaCap(),
        skillsCap()
      );
      const { principlesDir, filePath } = resolvePrinciplePaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
      await mkdir(principlesDir, { recursive: true });
      return withFileLock(filePath, async () => {
        const entries = await readJsonArray<DronePrincipleEntry>(filePath);
        entries.push({
          principle,
          source,
          createdAt: new Date().toISOString(),
        });
        await writeJsonArrayAtomic(filePath, entries);
        return { ok: true, principleCount: entries.length };
      });
    },
    listPrinciples: async (targetType, targetId) => {
      const results: Array<{
        targetType: string;
        targetId: string;
        principleCount: number;
      }> = [];

      if (targetType === 'persona') {
        const personasDir = path.join(projectDir, CONFIG_DIR, 'personas');
        try {
          const personaDirs = await readdir(personasDir);
          for (const pid of personaDirs) {
            if (targetId && pid !== targetId) continue;
            const principlesDir = path.join(
              personasDir,
              pid,
              PRINCIPLES_SUBDIR
            );
            const files = await scanJsonDir<DronePrincipleEntry>(principlesDir);
            for (const f of files) {
              results.push({
                targetType: 'persona',
                targetId: f.id === 'principles' ? pid : `${pid}/${f.id}`,
                principleCount: f.entryCount,
              });
            }
          }
        } catch {
          // No personas directory
        }
      } else {
        const dir = path.join(
          projectDir,
          CONFIG_DIR,
          PRINCIPLES_SUBDIR,
          targetType
        );
        const files = await scanJsonDir<DronePrincipleEntry>(dir);
        for (const f of files) {
          if (targetId && f.id !== targetId) continue;
          results.push({
            targetType,
            targetId: f.id,
            principleCount: f.entryCount,
          });
        }
      }

      return results;
    },
    readPrinciples: async (targetType, targetId) => {
      const baseDir = resolveBaseDir(
        targetType,
        targetId,
        projectDir,
        personaCap(),
        skillsCap()
      );
      const { filePath } = resolvePrinciplePaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
      return readJsonArray<DronePrincipleEntry>(filePath);
    },
    deletePrinciple: async (targetType, targetId, index) => {
      const baseDir = resolveBaseDir(
        targetType,
        targetId,
        projectDir,
        personaCap(),
        skillsCap()
      );
      const { filePath } = resolvePrinciplePaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
      return withFileLock(filePath, async () => {
        const entries = await readJsonArray<DronePrincipleEntry>(filePath);
        if (index >= entries.length) {
          throw new Error(
            `Index ${index} is out of bounds. The principles list has ${entries.length} entries.`
          );
        }
        entries.splice(index, 1);
        if (entries.length === 0) {
          try {
            await rm(filePath, { force: true });
          } catch {
            // Ignore
          }
        } else {
          await writeJsonArrayAtomic(filePath, entries);
        }
        return { ok: true, remainingCount: entries.length };
      });
    },
  };
}
