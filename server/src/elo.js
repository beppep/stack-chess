// Elo rating update. K is 40 for a player's first 20 rated games, then 20.
const k = rated => (rated < 20 ? 40 : 20);

export function rate(a, b, scoreA) {
  const expA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
  return {
    a: Math.round(a.rating + k(a.rated) * (scoreA - expA)),
    b: Math.round(b.rating + k(b.rated) * ((1 - scoreA) - (1 - expA))),
  };
}
