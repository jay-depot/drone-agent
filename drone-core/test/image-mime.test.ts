import { describe, expect, it } from 'vitest';
import {
  IMAGE_MIME_BY_EXT,
  SUPPORTED_IMAGE_EXTENSIONS,
  imageMimeForExtension,
  imageMimeForPath,
} from '../src/image-mime.js';

describe('IMAGE_MIME_BY_EXT', () => {
  it('maps every supported extension to its MIME type', () => {
    expect(IMAGE_MIME_BY_EXT['.jpg']).toBe('image/jpeg');
    expect(IMAGE_MIME_BY_EXT['.jpeg']).toBe('image/jpeg');
    expect(IMAGE_MIME_BY_EXT['.png']).toBe('image/png');
    expect(IMAGE_MIME_BY_EXT['.webp']).toBe('image/webp');
    expect(IMAGE_MIME_BY_EXT['.gif']).toBe('image/gif');
  });
});

describe('SUPPORTED_IMAGE_EXTENSIONS', () => {
  it('lists the five dotted extensions in declaration order', () => {
    expect(SUPPORTED_IMAGE_EXTENSIONS).toEqual([
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.gif',
    ]);
  });
});

describe('imageMimeForExtension', () => {
  it('resolves each supported extension', () => {
    expect(imageMimeForExtension('.jpg')).toBe('image/jpeg');
    expect(imageMimeForExtension('.jpeg')).toBe('image/jpeg');
    expect(imageMimeForExtension('.png')).toBe('image/png');
    expect(imageMimeForExtension('.webp')).toBe('image/webp');
    expect(imageMimeForExtension('.gif')).toBe('image/gif');
  });

  it('is case-insensitive', () => {
    expect(imageMimeForExtension('.PNG')).toBe('image/png');
    expect(imageMimeForExtension('.Gif')).toBe('image/gif');
  });

  it('returns undefined for non-image extensions', () => {
    expect(imageMimeForExtension('.md')).toBeUndefined();
    expect(imageMimeForExtension('.ts')).toBeUndefined();
    expect(imageMimeForExtension('.txt')).toBeUndefined();
  });

  it('returns undefined when there is no extension', () => {
    expect(imageMimeForExtension('')).toBeUndefined();
    expect(imageMimeForExtension('png')).toBeUndefined();
  });
});

describe('imageMimeForPath', () => {
  it('detects images by path extension', () => {
    expect(imageMimeForPath('a/b/pic.png')).toBe('image/png');
    expect(imageMimeForPath('/abs/photo.jpeg')).toBe('image/jpeg');
    expect(imageMimeForPath('shot.webp')).toBe('image/webp');
    expect(imageMimeForPath('anim.gif')).toBe('image/gif');
  });

  it('is case-insensitive', () => {
    expect(imageMimeForPath('a/b/pic.PNG')).toBe('image/png');
    expect(imageMimeForPath('a/b/pic.JPEG')).toBe('image/jpeg');
  });

  it('handles Windows-style separators', () => {
    expect(imageMimeForPath('C:\\pics\\shot.GIF')).toBe('image/gif');
  });

  it('returns undefined for non-image paths', () => {
    expect(imageMimeForPath('notes.md')).toBeUndefined();
    expect(imageMimeForPath('src/index.ts')).toBeUndefined();
    expect(imageMimeForPath('noext')).toBeUndefined();
  });

  it('only considers the final extension', () => {
    expect(imageMimeForPath('pic.tar.gz')).toBeUndefined();
    expect(imageMimeForPath('backup.png.zip')).toBeUndefined();
  });

  it('does not treat a directory name as an image', () => {
    expect(imageMimeForPath('assets/png/')).toBeUndefined();
  });
});
