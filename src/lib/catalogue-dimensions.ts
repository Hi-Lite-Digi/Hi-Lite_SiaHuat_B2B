const METRIC_DIMENSION_GROUP = /(?:^|[^\d.])(?:[lwhd]\s*[:=]?\s*)?(\d+(?:\.\d+)?)\s*(cm|mm)?\s*(?:x|by|×|\*)\s*(?:[lwhd]\s*[:=]?\s*)?(\d+(?:\.\d+)?)\s*(cm|mm)?(?:\s*(?:x|by|×|\*)\s*(?:[lwhd]\s*[:=]?\s*)?(\d+(?:\.\d+)?)\s*(cm|mm)?)?/gi;

function metricDimensionGroups(value: string) {
  return [...value.matchAll(METRIC_DIMENSION_GROUP)].flatMap((match) => {
    const fallbackUnit = match[6] ?? match[4] ?? match[2];
    if (!fallbackUnit) return [];

    const sides = [
      { value: match[1], unit: match[2] ?? fallbackUnit },
      { value: match[3], unit: match[4] ?? fallbackUnit },
      ...(match[5] ? [{ value: match[5], unit: match[6] ?? fallbackUnit }] : []),
    ].map(({ value: side, unit }) => {
      const numericSide = Number.parseFloat(side);
      return unit.toLowerCase() === "mm" ? numericSide / 10 : numericSide;
    });

    return sides.every(Number.isFinite) ? [sides] : [];
  });
}

function containsMatchingSides(requested: number[], candidate: number[], toleranceCm = 1) {
  if (candidate.length < requested.length) return false;
  const requestedSides = [...requested].sort((left, right) => left - right);
  const candidateSides = [...candidate].sort((left, right) => left - right);

  function matchFrom(requestedIndex: number, candidateIndex: number): boolean {
    if (requestedIndex === requestedSides.length) return true;
    for (let index = candidateIndex; index < candidateSides.length; index += 1) {
      if (Math.abs(requestedSides[requestedIndex] - candidateSides[index]) <= toleranceCm
        && matchFrom(requestedIndex + 1, index + 1)) return true;
    }
    return false;
  }

  return matchFrom(0, 0);
}

/**
 * Returns null when the request has no 2D/3D metric dimension constraint.
 * Otherwise every requested dimension group must occur in a candidate group.
 */
export function metricDimensionConstraintsMatch(requestedText: string, candidateText: string) {
  const requestedGroups = metricDimensionGroups(requestedText);
  if (requestedGroups.length === 0) return null;
  const candidateGroups = metricDimensionGroups(candidateText);
  return requestedGroups.every((requested) =>
    candidateGroups.some((candidate) => containsMatchingSides(requested, candidate)),
  );
}
