import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from './wiki-frontmatter';

describe('splitFrontmatter', () => {
  it('splits a leading frontmatter block from the body', () => {
    const content = [
      '---',
      'id: my-page',
      'title: My Page',
      'scope: coordinator',
      '---',
      '',
      '# Heading',
      '',
      'Body text.',
    ].join('\n');
    expect(splitFrontmatter(content)).toEqual({
      frontmatter: 'id: my-page\ntitle: My Page\nscope: coordinator',
      body: '# Heading\n\nBody text.',
    });
  });

  it('returns the content unchanged when there is no leading block', () => {
    const content = '# Heading\n\nJust body text.';
    expect(splitFrontmatter(content)).toEqual({
      frontmatter: null,
      body: content,
    });
  });

  it('only splits a leading block, not a later --- separator', () => {
    const content = [
      '---',
      'id: my-page',
      '---',
      '',
      'Body with a --- separator later.',
    ].join('\n');
    expect(splitFrontmatter(content)).toEqual({
      frontmatter: 'id: my-page',
      body: 'Body with a --- separator later.',
    });
  });

  it('handles an empty body after the block', () => {
    const content = '---\nid: my-page\n---\n';
    expect(splitFrontmatter(content)).toEqual({
      frontmatter: 'id: my-page',
      body: '',
    });
  });
});
