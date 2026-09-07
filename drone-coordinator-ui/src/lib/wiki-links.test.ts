import { describe, it, expect } from 'vitest';
import { preprocessWikiLinks } from './wiki-links';

describe('preprocessWikiLinks', () => {
  it('leaves plain text untouched', () => {
    expect(preprocessWikiLinks('Just some plain text.')).toBe(
      'Just some plain text.'
    );
  });

  it('converts a bare [[target]] to an internal markdown link', () => {
    expect(preprocessWikiLinks('See [[deployment]] for details')).toBe(
      'See [deployment](/wiki/deployment) for details'
    );
  });

  it('converts [[target|alias]] using the alias as the label', () => {
    expect(preprocessWikiLinks('See [[deployment|Deploy Guide]]')).toBe(
      'See [Deploy Guide](/wiki/deployment)'
    );
  });

  it('handles multiple wikilinks in one string', () => {
    expect(preprocessWikiLinks('[[a]] and [[b|c]] and [[d]]')).toBe(
      '[a](/wiki/a) and [c](/wiki/b) and [d](/wiki/d)'
    );
  });

  it('URL-encodes the target in the href', () => {
    expect(preprocessWikiLinks('[[my page]]')).toBe(
      '[my page](/wiki/my%20page)'
    );
  });

  it('escapes markdown special characters in the label', () => {
    expect(preprocessWikiLinks('[[deploy|Deploy *now*]]')).toBe(
      '[Deploy \\*now\\*](/wiki/deploy)'
    );
  });

  it('passes through non-wikilink markdown unchanged', () => {
    const md = '# Heading\n\nSome **bold** and [a link](https://example.com).';
    expect(preprocessWikiLinks(md)).toBe(md);
  });
});
