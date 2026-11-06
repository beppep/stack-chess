# Puzzle ideas (Bror, 2026-11-05)

For the later Puzzles project. Written down as Bror described them; not checked yet.
"Mate in 2.5" is Bror's count (half-turns on the stack count as halves).

On the site (beta/index.html, `PUZZLES`), each checked by the exact search:
- e1 "Two attackers": W Kf1 Re8 Bd7, B Ke6, White to move. Claude's guess at idea 1; wins in 2, not 1; 19 first moves win.
- e2 "Lone rook": W Ke8 Re4, B Kh4, White to move. Claude's guess at idea 2; wins in 2, not 1; only the 5 king moves win first.
- m1 "The pawn bites": idea 3 below, White to move; wins in 3, not 2; 14 first moves win.
- e3 "Cornered": W Ka8, B Kc8 with Kc8–b8 already on the stack, White to respond. From Bror's description; every such corner position is exactly mate in 2.5; here 2 first moves win (Ka7, Kb7).
- m2 "Quiet queen": W Kh1 Qc1, B Kd6 (not attacked), White to move. From Bror's description; wins in 3, not 2; 3 first moves win (all king moves).
- h1 "Only one way" (hard): W Kb1 Rg5, B Kc8 Pc5, White to move. Found by search: needs 4 turns, then Black must resolve (mate in 4.5); exactly one first move wins (Rg5xc5).
- h2 "Knight watch" (hard): W Kb1 Rg5 Nb6, B Kc8 Pc5 Pe4, White to move. Found by adding pieces to h1: needs 4 turns, the last one a resolve (mate in 4); 2 first moves win (Rg8, Rxc5).
- e4 "Knight and bishop": W Kb3 Nb1 Bg4, B Kd1 Pb4 (mate in 2.5; Kxb4 or Nd2).
- m4 "Rook lift": W Ke4 Rh3 Nf4 Pg3, B Kh5 Bb7 Pc3 (bishop attacks your king; mate in 4; 8 first moves win). m5 "Double attack": W Kb1 Rf7 Ng6 Pg4, B Ke7 Bd3 Pg3 (bishop attacks your king; label not verified).
- h3 "Crowded corner": W Kb1 Rg5 Nb6 Pa6, B Kc8 Pc5 Pa2 Nd2 (your king attacked twice, for Bror to test; label not verified).
All found by search, labels checked with the page's counting.
- e6 "Waiting game" (Bror's idea: bishop attacks the black king, white king two steps away, a black pawn to waste time): W Kh7 Bh3, B Kf5 Pb7. Mate in 4; only Kg6 wins first. Of 30 such positions tried, 22 were mate in 4, 5 mate in 3.5.
Replace the guesses with Bror's exact positions when he gives them.

Open (2026-11-06):
- Knight + rook + far pawn, White to move: no position of that kind found that White wins within 3 moves (~2,000 tried).
- Counting (Bror, 2026-11-06): resolving is part of your turn, so a turn that only resolves still counts. "Mate in N.5" = after N turns the defender must resolve and lose; "mate in N" = you resolve on turn N to win. With that, The pawn bites + a far black pawn (a7) is mate in 4 → added as m3 "The pawn bites back".

## Easy

1. Only the two kings plus attackers: the black king is threatened by 2 pieces. Mate in 2.5.
2. Only the two kings and a white rook threatening the black king. Mate in 2.5.

## Medium

3. From a screenshot (only files d–g and ranks 1–6 were visible):
   - White: King g1, Knight e3, Pawn g4
   - Black: King f5, Rook g2
   - Bror's note: the rook should try to take the pawn if the pawn takes the king. Mate in 3.5 (he thinks).

Starting stacks (2026-11-06), all 13 puzzles checked solvable in their labeled turns:
- m3 "The pawn bites back": stack g4xf5, Rg2xg4 (mate in 3; only Kxg2 wins first).
- m5 "Double attack": stack Ng6xe7, Ke7-f6 (mate in 3; only Rf7-e7 wins first).
- h3 "Crowded corner": W Kb1 Rg5 Nb6 Pa6, B Kc8 Pc5 Pa2 Nd2, stack Rg5xc5, Nd2-b3 (mate in 4.5; only resolve then a6-a7 wins first).
