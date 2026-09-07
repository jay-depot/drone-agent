/**
 * "Showdown" label overlap culling: every overlapping pair of labels is
 * conceptually a duel that the higher-ranked label wins; the loser hides.
 * The efficient equivalent ranks candidates best-first, then walks the list:
 * a label survives iff it intersects no higher-ranked candidate's rectangle
 * — whether or not that victor is itself culled (strict local-maxima: no
 * chain rescue, matching the literal lowest-first elimination). Ties in
 * score resolve by list position ("first listed wins"), made deterministic
 * by sorting equal scores by ascending id.
 */

export interface ShowdownRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ShowdownCandidate {
  id: string;
  score: number;
  rect: ShowdownRect;
}

function rectsOverlap(a: ShowdownRect, b: ShowdownRect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/**
 * Select the surviving label ids. Runs two geometrically independent
 * showdowns by receiving separate candidate lists per kind (pages never
 * cull tags and vice versa). A culled candidate's rectangle still counts
 * against weaker candidates, so a hidden label keeps its exclusion zone.
 */
export function selectShowdownSurvivors(
  candidates: ShowdownCandidate[]
): Set<string> {
  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const survivors = new Set<string>();
  const rankedRects: ShowdownRect[] = [];
  for (const candidate of ranked) {
    if (!rankedRects.some(rect => rectsOverlap(rect, candidate.rect))) {
      survivors.add(candidate.id);
    }
    rankedRects.push(candidate.rect);
  }
  return survivors;
}
