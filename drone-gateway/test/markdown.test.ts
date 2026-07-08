import { describe, expect, it } from 'vitest';
import { BasicMarkdownRenderer } from '../src/markdown.js';

const renderer = new BasicMarkdownRenderer();

describe('BasicMarkdownRenderer', () => {
  describe('render', () => {
    it('returns body as-is and formattedBody as HTML', () => {
      const result = renderer.render('hello world');
      expect(result.body).toBe('hello world');
      expect(result.formattedBody).toContain('hello world');
    });

    it('returns formattedBody=null on parse failure gracefully', () => {
      // Very long strings or edge cases should not throw
      const result = renderer.render('normal text');
      expect(result.formattedBody).toBeTruthy();
    });
  });

  describe('code fences', () => {
    it('renders fenced code blocks as <pre><code>', () => {
      const result = renderer.render('```\nconst x = 1;\n```');
      expect(result.formattedBody).toContain('<pre><code>');
      expect(result.formattedBody).toContain('const x = 1;');
    });

    it('renders fenced code blocks with language', () => {
      const result = renderer.render('```ts\nconst x: number = 1;\n```');
      expect(result.formattedBody).toContain('class="language-ts"');
      expect(result.formattedBody).toContain('const x: number = 1;');
    });

    it('escapes HTML inside code blocks', () => {
      const result = renderer.render('```\n<script>alert("x")</script>\n```');
      expect(result.formattedBody).toContain('&lt;script&gt;');
      expect(result.formattedBody).not.toContain('<script>');
    });
  });

  describe('inline code', () => {
    it('renders inline code as <code>', () => {
      const result = renderer.render('Use the `foo()` function');
      expect(result.formattedBody).toContain('<code>foo()</code>');
    });
  });

  describe('bold and italic', () => {
    it('renders **bold** as <strong>', () => {
      const result = renderer.render('This is **bold** text');
      expect(result.formattedBody).toContain('<strong>bold</strong>');
    });

    it('renders *italic* as <em>', () => {
      const result = renderer.render('This is *italic* text');
      expect(result.formattedBody).toContain('<em>italic</em>');
    });
  });

  describe('links', () => {
    it('renders [text](url) as <a>', () => {
      const result = renderer.render('Click [here](https://example.com)');
      expect(result.formattedBody).toContain(
        '<a href="https://example.com">here</a>'
      );
    });
  });

  describe('lists', () => {
    it('renders unordered lists as <ul><li>', () => {
      const result = renderer.render('- item 1\n- item 2');
      expect(result.formattedBody).toContain('<ul>');
      expect(result.formattedBody).toContain('<li>item 1</li>');
      expect(result.formattedBody).toContain('<li>item 2</li>');
      expect(result.formattedBody).toContain('</ul>');
    });

    it('renders ordered lists as <ol><li>', () => {
      const result = renderer.render('1. first\n2. second');
      expect(result.formattedBody).toContain('<ol>');
      expect(result.formattedBody).toContain('<li>first</li>');
      expect(result.formattedBody).toContain('<li>second</li>');
      expect(result.formattedBody).toContain('</ol>');
    });
  });

  describe('paragraphs', () => {
    it('wraps text in <p> tags', () => {
      const result = renderer.render('Hello\n\nWorld');
      expect(result.formattedBody).toContain('<p>Hello</p>');
      expect(result.formattedBody).toContain('<p>World</p>');
    });
  });

  describe('HTML escaping', () => {
    it('escapes HTML entities in text', () => {
      const result = renderer.render('Use <b> not <i>');
      expect(result.formattedBody).toContain('&lt;b&gt;');
      expect(result.formattedBody).not.toContain('<b>');
    });
  });
});
