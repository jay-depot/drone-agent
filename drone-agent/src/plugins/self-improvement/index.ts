import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  DroneInsightEntry,
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DronePlugin,
  DronePrincipleEntry,
  DronePrinciplesCapability,
  DronePrincipleStorageEngine,
  DronePromptFragment,
  DroneSelfImprovementCapability,
  DroneSkillsCapability,
} from 'drone-core';

const CONFIG_DIR = '.drone-agent';
const INSIGHTS_SUBDIR = 'insights';
const PRINCIPLES_SUBDIR = 'principles';

type InsightFile = DroneInsightEntry[];
type PrinciplesFile = DronePrincipleEntry[];

/** In-memory counter for insights recorded this session. */
let insightCount = 0;

// ── Storage engine registry ─────────────────────────────────────────────

const insightEngines = new Map<string, DroneInsightStorageEngine>();
const principleEngines = new Map<string, DronePrincipleStorageEngine>();

// ── Shared helpers ─────────────────────────────────────────────────────

const VALID_TARGET_TYPES = ['persona', 'skill', 'project'] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

function isValidTargetType(t: string): t is TargetType {
  return VALID_TARGET_TYPES.includes(t as TargetType);
}

/**
 * Validate a target type and id. Throws on invalid input.
 */
function validateTarget(
  targetType: string,
  targetId: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): void {
  if (!isValidTargetType(targetType)) {
    throw new Error(
      `Invalid targetType "${targetType}". Must be "persona", "skill", or "project".`
    );
  }
  if (!targetId) {
    throw new Error('targetId must be a non-empty string.');
  }

  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      if (!persona) {
        throw new Error(
          `Unknown persona "${targetId}". Available: ${personaCap
            .getPersonas()
            .map(p => p.id)
            .join(', ')}`
        );
      }
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      if (!skill) {
        throw new Error(
          `Unknown skill "${targetId}". Available: ${skillsCap
            .getSkills()
            .map(s => s.id)
            .join(', ')}`
        );
      }
    }
  }
  // project — always valid
}

/**
 * Determine the scope of a target (project, user, beacon, coordinator).
 * Returns undefined for project targets (always local).
 */
function resolveTargetScope(
  targetType: string,
  targetId: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): string | undefined {
  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      return persona?.scope;
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      return (skill as any)?.scope;
    }
  }
  return undefined;
}

/**
 * Determine the base directory for a target, considering scope.
 */
function resolveBaseDir(
  targetType: string,
  targetId: string,
  projectDir: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): string {
  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      if (persona?.scope === 'user') {
        return os.homedir();
      }
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      if (skill?.source === 'user') {
        return os.homedir();
      }
    }
  }
  return projectDir;
}

/**
 * Resolve the directory and file path for an insights file.
 */
function resolveInsightPaths(
  targetType: string,
  targetId: string,
  baseDir: string,
  skillsCap?: DroneSkillsCapability
): { insightsDir: string; filePath: string } {
  if (targetType === 'persona') {
    const personaDir = path.join(baseDir, CONFIG_DIR, 'personas', targetId);
    return {
      insightsDir: path.join(personaDir, INSIGHTS_SUBDIR),
      filePath: path.join(personaDir, INSIGHTS_SUBDIR, 'insights.json'),
    };
  }

  if (targetType === 'skill') {
    const skill = skillsCap?.getSkill(targetId);
    if (skill?.personaId) {
      const personaDir = path.join(
        baseDir,
        CONFIG_DIR,
        'personas',
        skill.personaId
      );
      return {
        insightsDir: path.join(personaDir, INSIGHTS_SUBDIR),
        filePath: path.join(personaDir, INSIGHTS_SUBDIR, `${targetId}.json`),
      };
    }
  }

  return {
    insightsDir: path.join(baseDir, CONFIG_DIR, INSIGHTS_SUBDIR, targetType),
    filePath: path.join(
      baseDir,
      CONFIG_DIR,
      INSIGHTS_SUBDIR,
      targetType,
      `${targetId}.json`
    ),
  };
}

/**
 * Resolve the directory and file path for a principles file.
 */
function resolvePrinciplePaths(
  targetType: string,
  targetId: string,
  baseDir: string,
  skillsCap?: DroneSkillsCapability
): { principlesDir: string; filePath: string } {
  if (targetType === 'persona') {
    const personaDir = path.join(baseDir, CONFIG_DIR, 'personas', targetId);
    return {
      principlesDir: path.join(personaDir, PRINCIPLES_SUBDIR),
      filePath: path.join(personaDir, PRINCIPLES_SUBDIR, 'principles.json'),
    };
  }

  if (targetType === 'skill') {
    const skill = skillsCap?.getSkill(targetId);
    if (skill?.personaId) {
      const personaDir = path.join(
        baseDir,
        CONFIG_DIR,
        'personas',
        skill.personaId
      );
      return {
        principlesDir: path.join(personaDir, PRINCIPLES_SUBDIR),
        filePath: path.join(personaDir, PRINCIPLES_SUBDIR, `${targetId}.json`),
      };
    }
  }

  return {
    principlesDir: path.join(
      baseDir,
      CONFIG_DIR,
      PRINCIPLES_SUBDIR,
      targetType
    ),
    filePath: path.join(
      baseDir,
      CONFIG_DIR,
      PRINCIPLES_SUBDIR,
      targetType,
      `${targetId}.json`
    ),
  };
}

/**
 * Read a JSON array from a file, returning an empty array on missing/corrupt files.
 */
async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Scan a directory for JSON files and return a summary of each.
 */
async function scanJsonDir<T>(
  dir: string
): Promise<Array<{ id: string; entryCount: number; lastTimestamp?: string }>> {
  try {
    const entries = await readdir(dir);
    const results: Array<{
      id: string;
      entryCount: number;
      lastTimestamp?: string;
    }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      const filePath = path.join(dir, entry);
      const data = await readJsonArray<T>(filePath);
      const lastEntry = data.length > 0 ? data[data.length - 1] : undefined;
      results.push({
        id,
        entryCount: data.length,
        lastTimestamp: (lastEntry as Record<string, unknown>)?.timestamp as
          | string
          | undefined,
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ── Default file-based storage engine ────────────────────────────────────

/**
 * Create a file-based insight storage engine. This is the default for
 * local-scoped targets (project/user). It reads/writes JSON files in
 * .drone-agent/insights/ and .drone-agent/principles/.
 */
function createFileInsightEngine(
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
      const entries = await readJsonArray<DroneInsightEntry>(filePath);
      entries.push({ timestamp: new Date().toISOString(), insight });
      await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
      return { ok: true, entryCount: entries.length };
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

function createFilePrincipleEngine(
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
      const entries = await readJsonArray<DronePrincipleEntry>(filePath);
      entries.push({
        principle,
        source,
        createdAt: new Date().toISOString(),
      });
      await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
      return { ok: true, principleCount: entries.length };
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
            const files =
              await scanJsonDir<DronePrincipleEntry>(principlesDir);
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
      const { principlesDir, filePath } = resolvePrinciplePaths(
        targetType,
        targetId,
        baseDir,
        skillsCap()
      );
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
        await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
      }
      return { ok: true, remainingCount: entries.length };
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────────────

export const selfImprovementPlugin: DronePlugin = {
  metadata: {
    id: 'self-improvement',
    name: 'Self-Improvement',
    version: '0.1.0',
    description:
      'Records agent insights about personas, skills, or the project for later promotion into improvements. ' +
      'Also manages derived principles that are injected into persona prompts and skill recall results.',
    defaultEnabled: false,
    dependencies: [
      { id: 'persona', optional: true },
      { id: 'skills', optional: true },
    ],
  },
  register: async registration => {
    const projectDir = process.cwd();
    const personaCap = () =>
      registration.request<DronePersonaCapability>('persona');
    const skillsCap = () =>
      registration.request<DroneSkillsCapability>('skills');

    // Default file-based engines for local-scoped targets
    const defaultInsightEngine = createFileInsightEngine(
      'self-improvement-default',
      projectDir,
      personaCap,
      skillsCap
    );
    const defaultPrincipleEngine = createFilePrincipleEngine(
      'self-improvement-default',
      projectDir,
      personaCap,
      skillsCap
    );

    /**
     * Resolve the appropriate storage engine for a target.
     * For swarm-scoped targets (beacon/coordinator), looks up the
     * registered engine by provider ID. For local-scoped targets
     * (project/user), returns the default file-based engine.
     */
    function resolveInsightEngine(
      targetType: string,
      targetId: string
    ): DroneInsightStorageEngine {
      const scope = resolveTargetScope(
        targetType,
        targetId,
        personaCap(),
        skillsCap()
      );
      if (scope === 'beacon' || scope === 'coordinator') {
        // Look for a registered swarm engine
        for (const engine of insightEngines.values()) {
          return engine;
        }
      }
      return defaultInsightEngine;
    }

    function resolvePrincipleEngine(
      targetType: string,
      targetId: string
    ): DronePrincipleStorageEngine {
      const scope = resolveTargetScope(
        targetType,
        targetId,
        personaCap(),
        skillsCap()
      );
      if (scope === 'beacon' || scope === 'coordinator') {
        for (const engine of principleEngines.values()) {
          return engine;
        }
      }
      return defaultPrincipleEngine;
    }

    // ── Offer DroneSelfImprovementCapability ──────────────────────────
    const selfImprovementCapability: DroneSelfImprovementCapability = {
      registerInsightEngine: (engine: DroneInsightStorageEngine) => {
        insightEngines.set(engine.providerId, engine);
        registration.logger.info(
          `Registered insight engine: ${engine.providerId}`
        );
      },
      unregisterInsightEngine: (providerId: string) => {
        insightEngines.delete(providerId);
        registration.logger.info(
          `Unregistered insight engine: ${providerId}`
        );
      },
      registerPrincipleEngine: (engine: DronePrincipleStorageEngine) => {
        principleEngines.set(engine.providerId, engine);
        registration.logger.info(
          `Registered principle engine: ${engine.providerId}`
        );
      },
      unregisterPrincipleEngine: (providerId: string) => {
        principleEngines.delete(providerId);
        registration.logger.info(
          `Unregistered principle engine: ${providerId}`
        );
      },
      getPrinciples: async (targetType: string, targetId: string) => {
        const engine = resolvePrincipleEngine(targetType, targetId);
        return engine.readPrinciples(targetType, targetId);
      },
    };

    registration.offer(selfImprovementCapability);

    // ── Prompt fragment ──────────────────────────────────────────────
    registration.registerPromptFragment({
      key: 'insight-targets',
      phase: 'header',
      render: async () => {
        const lines: string[] = ['# Self-Improvement', ''];
        const pCap = personaCap();
        const activePersona = pCap?.getActivePersona();
        if (activePersona) {
          lines.push(
            'Current active persona: `' +
              activePersona.id +
              '`. ' +
              'Use `self-improvement.insight` with `targetType: "persona"` to record insights about it.'
          );
        }
        lines.push(
          'Use `persona.list` to see all available personas and `skills.list` to see available skills.'
        );
        lines.push(
          'Insight tools: `self-improvement.insight` (record), `self-improvement.insights-list` (browse), `self-improvement.insights-recall` (read).'
        );
        lines.push(
          'Principle tools: `self-improvement.principles-store` (create), `self-improvement.principles-list` (browse), `self-improvement.principles-recall` (read), `self-improvement.principles-delete` (remove).'
        );
        return lines.join('\n');
      },
    });

    // ── self-improvement.insight ─────────────────────────────────────
    registration.registerTool({
      name: 'insight',
      description:
        'Record a self-improvement insight about a persona, skill, or the project. ' +
        'Whenever you encounter an issue, gap, or opportunity related ' +
        'to a persona, skill, or the project itself, use this tool to log it as an insight. ' +
        'Do this proactively as you work, and do not worry about creating ' +
        'too many insights. They will be evaluated all together all at once ' +
        'to look for patterns, so more is better! Insights should be ' +
        'short and focused on a single observation or issue. ' +
        'Use `persona.list` and `skills.list` to discover valid IDs before calling this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description:
              'Whether this insight is about a persona, a skill, or the project.',
          },
          targetId: {
            type: 'string',
            description:
              'The id of the persona or skill this insight applies to. ' +
              'Use `persona.list` or `skills.list` to discover valid IDs. ' +
              'For project insights, use a descriptive category like "architecture" or "workflow".',
          },
          insight: {
            type: 'string',
            description:
              'A short (1-3 sentence) observation about what could be ' +
              'improved, what worked well, or what is missing.',
          },
        },
        required: ['targetType', 'targetId', 'insight'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        const insight = (input.insight as string).trim();

        if (!insight) {
          throw new Error('insight must be a non-empty string.');
        }

        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolveInsightEngine(targetType, targetId);
        const result = await engine.recordInsight(
          targetType,
          targetId,
          insight
        );
        insightCount += 1;

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            entryCount: result.entryCount,
            message: `Insight recorded for ${targetType} "${targetId}" via ${engine.providerId}.`,
          },
          null,
          2
        );
      },
    });

    // ── self-improvement.insights-list ─────────────────────────────────
    registration.registerTool({
      name: 'insights-list',
      description:
        'List all insight files with their entry counts and last timestamps. ' +
        'Optionally filter by targetType (persona, skill, or project).',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description:
              'Optional filter: only list insights for this target type.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const filterType = input.targetType as string | undefined;
        const results: Array<{
          targetType: string;
          targetId: string;
          entryCount: number;
          lastTimestamp?: string;
        }> = [];

        const typesToScan: TargetType[] =
          filterType && isValidTargetType(filterType)
            ? [filterType]
            : [...VALID_TARGET_TYPES];

        for (const tt of typesToScan) {
          // Collect from all registered insight engines
          for (const engine of insightEngines.values()) {
            const engineResults = await engine.listInsights(tt);
            results.push(...engineResults);
          }
          // Also collect from the default file-based engine
          const defaultResults = await defaultInsightEngine.listInsights(tt);
          results.push(...defaultResults);
        }

        return JSON.stringify({ insights: results }, null, 2);
      },
    });

    // ── self-improvement.insights-recall ──────────────────────────────
    registration.registerTool({
      name: 'insights-recall',
      description:
        'Read all insights for a specific target (persona, skill, or project).',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description: 'The type of target to read insights for.',
          },
          targetId: {
            type: 'string',
            description: 'The id of the persona, skill, or project category.',
          },
        },
        required: ['targetType', 'targetId'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolveInsightEngine(targetType, targetId);
        const entries = await engine.readInsights(targetType, targetId);
        return JSON.stringify({ targetType, targetId, entries }, null, 2);
      },
    });

    // ── self-improvement.principles-store ─────────────────────────────
    registration.registerTool({
      name: 'principles-store',
      description:
        'Store a principle for a persona, skill, or project. ' +
        'Principles are derived from patterns found in insights and are ' +
        'automatically injected into persona prompt fragments and skill recall results.',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description:
              'Whether this principle applies to a persona, a skill, or the project.',
          },
          targetId: {
            type: 'string',
            description:
              'The id of the persona or skill this principle applies to. ' +
              'For project principles, use a descriptive category like "architecture" or "workflow".',
          },
          principle: {
            type: 'string',
            description:
              'The principle text. Should be a concise, actionable statement.',
          },
          source: {
            type: 'string',
            description:
              'Optional description of where this principle came from (e.g. "Derived from 3 insights about code style").',
          },
        },
        required: ['targetType', 'targetId', 'principle'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        const principle = (input.principle as string).trim();
        const source =
          (input.source as string | undefined)?.trim() || undefined;

        if (!principle) {
          throw new Error('principle must be a non-empty string.');
        }

        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(targetType, targetId);
        const result = await engine.storePrinciple(
          targetType,
          targetId,
          principle,
          source
        );

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            principleCount: result.principleCount,
            message: `Principle stored for ${targetType} "${targetId}" via ${engine.providerId}.`,
          },
          null,
          2
        );
      },
    });

    // ── self-improvement.principles-list ──────────────────────────────
    registration.registerTool({
      name: 'principles-list',
      description:
        'List all principle files with their entry counts. ' +
        'Optionally filter by targetType (persona, skill, or project).',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description:
              'Optional filter: only list principles for this target type.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const filterType = input.targetType as string | undefined;
        const results: Array<{
          targetType: string;
          targetId: string;
          principleCount: number;
        }> = [];

        const typesToScan: TargetType[] =
          filterType && isValidTargetType(filterType)
            ? [filterType]
            : [...VALID_TARGET_TYPES];

        for (const tt of typesToScan) {
          for (const engine of principleEngines.values()) {
            const engineResults = await engine.listPrinciples(tt);
            results.push(...engineResults);
          }
          const defaultResults =
            await defaultPrincipleEngine.listPrinciples(tt);
          results.push(...defaultResults);
        }

        return JSON.stringify({ principles: results }, null, 2);
      },
    });

    // ── self-improvement.principles-recall ────────────────────────────
    registration.registerTool({
      name: 'principles-recall',
      description:
        'Read all principles for a specific target (persona, skill, or project).',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description: 'The type of target to read principles for.',
          },
          targetId: {
            type: 'string',
            description: 'The id of the persona, skill, or project category.',
          },
        },
        required: ['targetType', 'targetId'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(targetType, targetId);
        const principles = await engine.readPrinciples(targetType, targetId);
        return JSON.stringify({ targetType, targetId, principles }, null, 2);
      },
    });

    // ── self-improvement.principles-delete ────────────────────────────
    registration.registerTool({
      name: 'principles-delete',
      description:
        'Delete a principle by its index in the principles list for a target.',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description: 'The type of target to delete a principle from.',
          },
          targetId: {
            type: 'string',
            description: 'The id of the persona, skill, or project category.',
          },
          index: {
            type: 'integer',
            description: 'The 0-based index of the principle to delete.',
          },
        },
        required: ['targetType', 'targetId', 'index'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        const index = input.index as number;

        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          throw new Error('index must be a non-negative integer.');
        }

        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(targetType, targetId);
        const result = await engine.deletePrinciple(
          targetType,
          targetId,
          index
        );

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            remainingCount: result.remainingCount,
            message: `Principle deleted from ${targetType} "${targetId}" via ${engine.providerId}.`,
          },
          null,
          2
        );
      },
    });

    // ── Offer DronePrinciplesCapability (backwards compat) ──────────────
    const principlesCapability: DronePrinciplesCapability = {
      getPrinciples: async (targetType: string, targetId: string) => {
        return selfImprovementCapability.getPrinciples(targetType, targetId);
      },
    };

    registration.offer(principlesCapability);

    // ── Combined principles prompt fragment (project + persona) ────
    registration.registerPromptFragment({
      key: 'principles',
      phase: 'footer',
      render: async () => {
        const sections: string[] = [];

        // ── Project Principles ───────────────────────────────────────
        const projectPrinciplesDir = path.join(
          projectDir,
          CONFIG_DIR,
          PRINCIPLES_SUBDIR,
          'project'
        );
        const projectFiles =
          await scanJsonDir<DronePrincipleEntry>(projectPrinciplesDir);

        const haveProject = projectFiles.length > 0;
        const activePersona = personaCap()?.getActivePersona();
        const havePersona = !!activePersona;

        if (haveProject || havePersona) {
          sections.push('# Principles');
          sections.push(
            '**You have learned the following principles from your prior experiences. Let them guide your decisions.**'
          );

          if (haveProject) {
            const projectLines: string[] = ['## Current Project'];
            for (const file of projectFiles) {
              const filePath = path.join(
                projectPrinciplesDir,
                `${file.id}.json`
              );
              const principles =
                await readJsonArray<DronePrincipleEntry>(filePath);
              if (principles.length > 0) {
                projectLines.push(`### ${file.id}`);
                for (const p of principles) {
                  projectLines.push(`- ${p.principle}`);
                }
              }
            }
            if (projectLines.length > 1) {
              sections.push(projectLines.join('\n'));
            }
          }

          // ── Persona Principles ────────────────────────────────────────
          if (havePersona) {
            const engine = resolvePrincipleEngine(
              'persona',
              activePersona.id
            );
            const principles = await engine.readPrinciples(
              'persona',
              activePersona.id
            );

            if (principles.length > 0) {
              const personaLines = ['## Current Persona'];
              personaLines.push(`### ${activePersona.id}`);
              for (const p of principles) {
                personaLines.push(`- ${p.principle}`);
              }
              sections.push(personaLines.join('\n'));
            }
          }
        }

        return sections.length > 0 ? sections.join('\n\n') : false;
      },
    });

    // ── onPluginsLoaded: register recall enhancer + log status ──────
    registration.hooks.onPluginsLoaded(async () => {
      const sCap = skillsCap();
      if (sCap?.onRecall) {
        sCap.onRecall(async (id, body) => {
          const principles = await selfImprovementCapability.getPrinciples(
            'skill',
            id
          );
          if (principles.length === 0) return body;
          const lines = ['\n## Principles'];
          for (const p of principles) {
            lines.push('- ' + p.principle);
          }
          return body + lines.join('\n');
        });
      }

      registration.logger.info(
        'self-improvement plugin ready (broker mode: routes to provider-registered storage engines; ' +
          'defaults to file-based storage in .drone-agent/insights/ and .drone-agent/principles/)'
      );
    });
  },
};
