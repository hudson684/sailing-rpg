/**
 * Exponential XP curve. Level 100 max at 10,000,000 XP.
 * Each level requires ~10% more XP than the previous.
 * Ported from fantasyidlegame's xpTable.
 */

const MAX_LEVEL = 100;
const MAX_XP = 10_000_000;
const RATIO = 1.1;

const XP_TABLE: number[] = [0];

{
  const C = (MAX_XP * (RATIO - 1)) / (Math.pow(RATIO, MAX_LEVEL - 1) - 1);
  for (let level = 1; level < MAX_LEVEL; level++) {
    const xp = Math.floor((C * (Math.pow(RATIO, level) - 1)) / (RATIO - 1));
    XP_TABLE.push(xp);
  }
  XP_TABLE.push(MAX_XP);
}

/** Total XP needed to reach the given level (1..MAX_LEVEL). */
export function xpForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_LEVEL, level));
  return XP_TABLE[clamped] ?? 0;
}

/** Level derived from total XP. */
export function levelFromXp(xp: number): number {
  for (let level = MAX_LEVEL - 1; level >= 1; level--) {
    if (xp >= XP_TABLE[level]) return level;
  }
  return 1;
}

/** XP needed to go from `currentLevel` to `currentLevel + 1`. */
export function xpToNextLevel(currentLevel: number): number {
  if (currentLevel >= MAX_LEVEL) return 0;
  return xpForLevel(currentLevel + 1) - xpForLevel(currentLevel);
}

/** XP earned within the current level (0 to xpToNextLevel). */
export function xpInCurrentLevel(xp: number, currentLevel: number): number {
  return xp - xpForLevel(currentLevel);
}

export { MAX_LEVEL };
