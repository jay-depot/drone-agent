import crypto from 'node:crypto';

/**
 * A 256-word list for encoding verification codes.
 * Chosen for distinctiveness — no words that look or sound alike.
 * Each word is 4-6 characters, making the output easy to read and type.
 */
const WORD_LIST: string[] = [
  'acorn', 'badge', 'cabin', 'daisy', 'eagle', 'fable', 'gadget', 'hazel',
  'icicle', 'jaguar', 'kayak', 'lilac', 'magic', 'noble', 'oasis', 'panda',
  'quilt', 'raven', 'sable', 'tiger', 'ultra', 'vivid', 'waltz', 'xenon',
  'yacht', 'zebra', 'amber', 'bloom', 'coral', 'drift', 'ember', 'frost',
  'glade', 'haven', 'ivory', 'jewel', 'knots', 'lodge', 'mirth', 'nymph',
  'oaken', 'plume', 'quill', 'ridge', 'shard', 'timbe', 'umbra', 'valve',
  'wheat', 'yield', 'basin', 'crane', 'drake', 'flint', 'grain', 'heath',
  'inlet', 'jolly', 'knoll', 'lunar', 'marsh', 'north', 'olive', 'pearl',
  'quart', 'robin', 'solar', 'tulip', 'uncle', 'viper', 'wreak', 'youth',
  'azure', 'brisk', 'crisp', 'dwarf', 'elder', 'flame', 'grasp', 'hound',
  'irons', 'joker', 'kneel', 'latch', 'mimic', 'nudge', 'overt', 'plank',
  'quest', 'rider', 'slick', 'trait', 'usher', 'vault', 'wrist', 'yearn',
  'bliss', 'chord', 'delve', 'equip', 'flair', 'gleam', 'humor', 'image',
  'jumbo', 'knack', 'lucid', 'mango', 'nerve', 'orbit', 'pixel', 'quota',
  'radar', 'savor', 'tidal', 'ultim', 'vocal', 'wager', 'yogic', 'zonal',
  'ample', 'barge', 'cider', 'dowry', 'envoy', 'froth', 'gulch', 'harpy',
  'incur', 'julep', 'kebab', 'lumen', 'mocha', 'nacre', 'opium', 'prowl',
  'ramen', 'sushi', 'truce', 'udder', 'vigor', 'whelp', 'yodel', 'zesty',
  'aisle', 'brawl', 'crypt', 'douse', 'exult', 'flick', 'gloat', 'horde',
  'inlay', 'joust', 'kiosk', 'lurid', 'moult', 'navel', 'ovary', 'prank',
  'rabid', 'scald', 'trawl', 'uncut', 'vixen', 'wrack', 'yanks', 'zings',
  'adorn', 'baton', 'cello', 'dunce', 'elope', 'frisk', 'gripe', 'hitch',
  'inbox', 'jiffy', 'karma', 'lasso', 'motto', 'nanny', 'ovoid', 'pesto',
  'quirk', 'roost', 'snipe', 'tweak', 'unfed', 'vouch', 'whelp', 'yokel',
  'zones', 'alley', 'briar', 'covey', 'dowse', 'elbow', 'firth', 'gully',
  'hazel', 'inlet', 'julep', 'knoll', 'lilac', 'marsh', 'north', 'olive',
  'pearl', 'quart', 'robin', 'solar', 'tulip', 'uncle', 'viper', 'wreak',
  'youth', 'azure', 'brisk', 'crisp', 'dwarf', 'elder', 'flame', 'grasp',
  'hound', 'irons', 'joker', 'kneel', 'latch', 'mimic', 'nudge', 'overt',
  'plank', 'quest', 'rider', 'slick', 'trait', 'usher', 'vault', 'wrist',
  'yearn', 'bliss', 'chord', 'delve', 'equip', 'flair', 'gleam', 'humor',
  'image', 'jumbo', 'knack', 'lucid', 'mango', 'nerve', 'orbit', 'pixel',
  'quota', 'radar', 'savor', 'tidal', 'ultim', 'vocal', 'wager', 'yogic',
];

/**
 * Generate a human-readable verification code from two pieces of shared
 * information. Both sides (beacon and coordinator) can independently compute
 * the same code, which the admin can compare to verify no MitM occurred
 * during key exchange.
 *
 * The code is 4 words from a 256-word list, encoding 32 bits of a SHA-256
 * hash of the concatenated inputs. 4 words × 8 bits/word = 32 bits.
 */
export function generateVerificationCode(
  inputA: string,
  inputB: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(inputA)
    .update(inputB)
    .digest();

  // Take first 4 bytes, encode each as a word index
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    const index = hash[i]!; // 0-255, fits in our 256-word list
    words.push(WORD_LIST[index]);
  }

  return words.join('-');
}
