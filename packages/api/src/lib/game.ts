import { get_game_grid } from "@minesweeper/proving_system/circuits";
import type { cell } from "@minesweeper/proving_system/circuits";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const GRID_SIZE = 9;
export const TOTAL_CELLS = 81;
export const MINE_COUNT = 10;
export const SAFE_CELLS = TOTAL_CELLS - MINE_COUNT; // 71
export const MINE_VALUE = 9;
export const SENTINEL = 255;

// ---------------------------------------------------------------------------
// Board generation — delegates to the ZK circuit's unconstrained oracle
// ---------------------------------------------------------------------------
export async function generateBoard(seed: string) {
  const [grid, merkleRoot] = await get_game_grid(seed);
  return { grid, merkleRoot: merkleRoot as string };
}

// ---------------------------------------------------------------------------
// BFS Cascade — flood-fill for value=0 cells + boundary numbers
// ---------------------------------------------------------------------------
export interface RevealedCell {
  index: number;
  value: number;
}

export function getCascade(
  grid: cell[],
  startIndex: number,
): RevealedCell[] {
  const startCell = grid[startIndex];
  if (!startCell) return [];

  const startValue = Number(startCell.value);

  // If the cell isn't a zero, just return that single cell
  if (startValue !== 0) {
    return [{ index: startIndex, value: startValue }];
  }

  // BFS flood-fill
  const revealed: RevealedCell[] = [];
  const visited = new Set<number>();
  const queue: number[] = [startIndex];

  while (queue.length > 0) {
    const idx = queue.shift()!;
    if (visited.has(idx)) continue;
    visited.add(idx);

    const cell = grid[idx];
    if (!cell) continue;
    const value = Number(cell.value);

    revealed.push({ index: idx, value });

    // Only expand from zero-value cells
    if (value === 0) {
      const neighbors = getNeighborIndices(idx);
      for (const neighborIdx of neighbors) {
        if (!visited.has(neighborIdx)) {
          queue.push(neighborIdx);
        }
      }
    }
  }

  return revealed;
}

// ---------------------------------------------------------------------------
// Neighbor resolution (mirrors the Noir circuit's get_cell_neighbors)
// ---------------------------------------------------------------------------
function getNeighborIndices(index: number): number[] {
  const row = Math.floor(index / GRID_SIZE);
  const col = index % GRID_SIZE;
  const neighbors: number[] = [];

  const dRows = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dCols = [-1, 0, 1, -1, 1, -1, 0, 1];

  for (let i = 0; i < 8; i++) {
    const newRow = row + dRows[i]!;
    const newCol = col + dCols[i]!;
    if (newRow >= 0 && newRow < GRID_SIZE && newCol >= 0 && newCol < GRID_SIZE) {
      neighbors.push(newRow * GRID_SIZE + newCol);
    }
  }
  return neighbors;
}

// ---------------------------------------------------------------------------
// XP Calculation per the product brief
// ---------------------------------------------------------------------------
export function calculateXP(
  revealedCells: RevealedCell[],
  isVictory: boolean,
): number {
  let baseXP = 0;
  for (const cell of revealedCells) {
    if (cell.value === 0) {
      baseXP += 10; // Absolute safe cell
    } else if (cell.value >= 1 && cell.value <= 8) {
      baseXP += cell.value; // Relative safe cell — XP = number
    }
    // Mines (value 9) award 0 XP
  }

  if (isVictory) {
    baseXP += 250; // Victory bonus
  }

  return baseXP;
}

// ---------------------------------------------------------------------------
// Game Log Validation — programmatic sanity check (DoS prevention)
// ---------------------------------------------------------------------------
export interface GameLogEntry {
  index: number;
  value: number;
}

export function validateGameLog(
  gameLog: GameLogEntry[],
  dbCells: { index: number; value: number }[],
): { valid: boolean; reason?: string } {
  const cellMap = new Map<number, number>();
  for (const cell of dbCells) {
    cellMap.set(cell.index, cell.value);
  }

  for (const entry of gameLog) {
    const trueValue = cellMap.get(entry.index);
    if (trueValue === undefined) {
      return { valid: false, reason: `Cell index ${entry.index} not found in database` };
    }
    if (trueValue !== entry.value) {
      return {
        valid: false,
        reason: `Cell ${entry.index}: log says ${entry.value}, DB says ${trueValue}`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Pad game log arrays to fixed size of 71 (required by GAME_STATE circuit)
// ---------------------------------------------------------------------------
export function padGameLog(gameLog: GameLogEntry[]): {
  logIndices: string[];
  logValues: string[];
} {
  const logIndices: string[] = gameLog.map((e) => e.index.toString());
  const logValues: string[] = gameLog.map((e) => e.value.toString());

  // Pad to 71 with sentinel value 255
  for (let i = gameLog.length; i < SAFE_CELLS; i++) {
    logIndices.push(SENTINEL.toString());
    logValues.push(SENTINEL.toString());
  }

  return { logIndices, logValues };
}
