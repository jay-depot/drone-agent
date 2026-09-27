/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { DroneSkillDefinition, DroneSkillsCapability } from 'drone-core';
import {
  resolveInsightPaths,
  resolvePrinciplePaths,
} from '../../src/plugins/self-improvement/paths.js';

function makeSkillsCap(skill: Partial<DroneSkillDefinition>): DroneSkillsCapability {
  const full = { id: 'owned', ...skill } as DroneSkillDefinition;
  return {
    getSkills: () => [full],
    getSkill: () => full,
    renderSkillBody: async () => undefined,
    reloadSkills: async () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerWriter: () => {},
    unregisterWriter: () => {},
    getWriters: () => [],
    onRecall: () => {},
  };
}

const BASE = '/base';

describe('self-improvement paths — persona-owned skill routing', () => {
  it('routes a local (project) owned skill under the persona directory', () => {
    const cap = makeSkillsCap({ personaId: 'alice', source: 'project' });
    const { filePath } = resolveInsightPaths('skill', 'owned', BASE, cap);
    expect(filePath).toBe(
      path.join(BASE, '.drone-agent', 'personas', 'alice', 'insights', 'owned.json')
    );
  });

  it('routes a local (user) owned skill under the persona directory', () => {
    const cap = makeSkillsCap({ personaId: 'alice', source: 'user' });
    const { filePath } = resolvePrinciplePaths('skill', 'owned', BASE, cap);
    expect(filePath).toBe(
      path.join(
        BASE,
        '.drone-agent',
        'personas',
        'alice',
        'principles',
        'owned.json'
      )
    );
  });

  it('does NOT route a swarm-owned (coordinator) skill under a persona dir', () => {
    const cap = makeSkillsCap({ personaId: 'alice', source: 'coordinator' });
    const { filePath } = resolveInsightPaths('skill', 'owned', BASE, cap);
    expect(filePath).toBe(
      path.join(BASE, '.drone-agent', 'insights', 'skill', 'owned.json')
    );
    expect(filePath).not.toContain('personas');
  });

  it('does NOT route a swarm-owned (beacon) skill under a persona dir', () => {
    const cap = makeSkillsCap({ personaId: 'alice', source: 'beacon' });
    const { filePath } = resolvePrinciplePaths('skill', 'owned', BASE, cap);
    expect(filePath).toBe(
      path.join(BASE, '.drone-agent', 'principles', 'skill', 'owned.json')
    );
  });

  it('leaves a global skill on the normal scope path', () => {
    const cap = makeSkillsCap({ source: 'project' });
    const { filePath } = resolveInsightPaths('skill', 'owned', BASE, cap);
    expect(filePath).toBe(
      path.join(BASE, '.drone-agent', 'insights', 'skill', 'owned.json')
    );
  });
});
