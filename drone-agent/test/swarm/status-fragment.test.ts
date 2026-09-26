import { describe, expect, it } from 'vitest';
import { createSwarmInfoStore } from '../../src/plugins/swarm/swarm-info.js';
import { createSwarmStatusFragment } from '../../src/plugins/swarm/status-fragment.js';

describe('swarm status fragment', () => {
  it('hides itself when neither info nor roster is known', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    const fragment = createSwarmStatusFragment(store);
    await expect(fragment.render()).resolves.toBe(false);
  });

  it('renders the beacon name, address, coordinator and roster', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    store.applyBeaconInfo({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: 'coord.example',
      coordinatorPort: 3456,
    });
    store.replaceRoster([
      {
        id: 'b1',
        name: 'home-office',
        host: 'localhost',
        port: 3457,
        connected: true,
        trustStatus: 'approved',
      },
      {
        id: 'b2',
        name: 'workshop',
        host: '10.0.0.2',
        port: 3457,
        connected: true,
        trustStatus: 'approved',
      },
    ]);

    const fragment = createSwarmStatusFragment(store);
    const rendered = (await fragment.render()) as string;
    expect(rendered).toContain('# Swarm Status');
    expect(rendered).toContain('- Local beacon: home-office (localhost:3457)');
    expect(rendered).toContain('- Coordinator: coord.example:3456');
    expect(rendered).toContain('- Registered beacons (2):');
    expect(rendered).toContain('  - home-office (localhost:3457)');
    expect(rendered).toContain('  - workshop (10.0.0.2:3457)');
  });

  it('omits the coordinator line when unconfigured', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    store.applyBeaconInfo({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: null,
      coordinatorPort: null,
    });
    const rendered = (await createSwarmStatusFragment(
      store
    ).render()) as string;
    expect(rendered).not.toContain('- Coordinator:');
  });

  it('marks offline and non-approved beacons', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    store.applyBeaconInfo({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: null,
      coordinatorPort: null,
    });
    store.replaceRoster([
      {
        id: 'b2',
        name: 'laptop',
        host: '10.0.0.3',
        port: 3457,
        connected: false,
        trustStatus: 'approved',
      },
      {
        id: 'b3',
        name: 'workshop',
        host: '10.0.0.4',
        port: 3457,
        connected: true,
        trustStatus: 'pending',
      },
      {
        id: 'b4',
        name: 'rogue',
        host: '10.0.0.5',
        port: 3457,
        connected: true,
        trustStatus: 'rejected',
      },
    ]);
    const rendered = (await createSwarmStatusFragment(
      store
    ).render()) as string;
    expect(rendered).toContain('laptop (10.0.0.3:3457) · offline');
    expect(rendered).toContain('workshop (10.0.0.4:3457) · pending approval');
    expect(rendered).toContain('rogue (10.0.0.5:3457) · rejected');
  });
});
