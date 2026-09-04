import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeApp, teardownApp, type TestCtx } from '../helpers/server.js';

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeApp();
});

afterEach(async () => {
  await teardownApp(ctx);
});

describe('Wiki Routes', () => {
  it('GET /api/wiki?tag=X returns only pages with tag X', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/ops-page',
      payload: {
        title: 'Ops Page',
        content: 'ops content',
        tags: ['ops'],
      },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/design-page',
      payload: {
        title: 'Design Page',
        content: 'design content',
        tags: ['design'],
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/wiki?tag=ops',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('ops-page');
  });

  it('GET /api/wiki?tag=X with no matches returns []', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/ops-page',
      payload: {
        title: 'Ops Page',
        content: 'ops content',
        tags: ['ops'],
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/wiki?tag=nonexistent',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('GET /api/wiki/tags returns distinct tags with counts, sorted', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/page-1',
      payload: {
        title: 'Page 1',
        content: 'content 1',
        tags: ['ops', 'design'],
      },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/page-2',
      payload: {
        title: 'Page 2',
        content: 'content 2',
        tags: ['ops'],
      },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/page-3',
      payload: {
        title: 'Page 3',
        content: 'content 3',
        tags: ['personal'],
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/wiki/tags',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([
      { tag: 'ops', count: 2 },
      { tag: 'design', count: 1 },
      { tag: 'personal', count: 1 },
    ]);
  });

  it('PUT /api/wiki/tags is rejected (reserved name) with 400', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/tags',
      payload: {
        title: 'Tags',
        content: 'should be rejected',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('reserved');
  });

  it('PUT /api/wiki/foo with tag X then GET /api/wiki?tag=X includes it', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/wiki/foo',
      payload: {
        title: 'Foo',
        content: 'foo content',
        tags: ['ops'],
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/wiki?tag=ops',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('foo');
  });
});
