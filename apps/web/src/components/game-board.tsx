import { useState, useCallback } from "react";

const GRID_SIZE = 9;
const MINE_VALUE = 9;

// Classic Minesweeper number colors
const NUMBER_COLORS: Record<number, string> = {
  1: "#3B82F6", // blue
  2: "#22C55E", // green
  3: "#EF4444", // red
  4: "#8B5CF6", // purple
  5: "#B91C1C", // dark red
  6: "#06B6D4", // cyan
  7: "#1F2937", // dark gray (in dark mode: white)
  8: "#6B7280", // gray
};

interface CellData {
  index: number;
  value: number;
}

interface GameBoardProps {
  gameId: string | null;
  revealedCells: Map<number, number>;
  flaggedCells: Set<number>;
  gameOver: boolean;
  isVictory: boolean;
  onCellClick: (index: number) => void;
  onCellRightClick: (index: number) => void;
  minePositions?: number[]; // Shown on game over (loss)
}

export default function GameBoard({
  gameId,
  revealedCells,
  flaggedCells,
  gameOver,
  isVictory,
  onCellClick,
  onCellRightClick,
  minePositions = [],
}: GameBoardProps) {
  const [pressedCell, setPressedCell] = useState<number | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      if (!gameOver && !revealedCells.has(index)) {
        onCellRightClick(index);
      }
    },
    [gameOver, revealedCells, onCellRightClick],
  );

  const handleClick = useCallback(
    (index: number) => {
      if (!gameOver && !revealedCells.has(index) && !flaggedCells.has(index)) {
        onCellClick(index);
      }
    },
    [gameOver, revealedCells, flaggedCells, onCellClick],
  );

  const renderCell = (index: number) => {
    const isRevealed = revealedCells.has(index);
    const isFlagged = flaggedCells.has(index);
    const value = revealedCells.get(index);
    const isMine = value === MINE_VALUE;
    const isExplodedMine = isMine && !isVictory;
    const isShowMine = gameOver && minePositions.includes(index) && !isFlagged;
    const isPressed = pressedCell === index;

    let cellContent: React.ReactNode = null;
    let cellClasses = "cell";

    if (isRevealed) {
      cellClasses += " cell-revealed";
      if (isMine) {
        cellClasses += " cell-mine";
        if (isExplodedMine) {
          cellClasses += " cell-exploded";
        }
        cellContent = <span className="cell-icon">💣</span>;
      } else if (value !== undefined && value > 0) {
        cellContent = (
          <span
            className="cell-number"
            style={{ color: NUMBER_COLORS[value] || "#fff" }}
          >
            {value}
          </span>
        );
      }
    } else if (isShowMine) {
      cellClasses += " cell-revealed cell-mine";
      cellContent = <span className="cell-icon">💣</span>;
    } else if (isFlagged) {
      cellClasses += " cell-flagged";
      cellContent = <span className="cell-icon">🚩</span>;
    } else {
      cellClasses += " cell-hidden";
      if (isPressed) {
        cellClasses += " cell-pressed";
      }
    }

    if (gameOver && isVictory && isRevealed) {
      cellClasses += " cell-victory";
    }

    return (
      <button
        key={index}
        id={`cell-${index}`}
        className={cellClasses}
        onClick={() => handleClick(index)}
        onContextMenu={(e) => handleContextMenu(e, index)}
        onMouseDown={() => setPressedCell(index)}
        onMouseUp={() => setPressedCell(null)}
        onMouseLeave={() => setPressedCell(null)}
        disabled={gameOver || isRevealed}
        aria-label={`Cell ${Math.floor(index / GRID_SIZE)},${index % GRID_SIZE}`}
      >
        {cellContent}
      </button>
    );
  };

  if (!gameId) {
    return (
      <div className="board-placeholder">
        <div className="board-placeholder-inner">
          <span className="board-placeholder-icon">💣</span>
          <p className="board-placeholder-text">
            Click <strong>New Game</strong> to start
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="board-container">
      <div className="board-grid" id="minesweeper-board">
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => renderCell(i))}
      </div>
      {gameOver && (
        <div className={`board-overlay ${isVictory ? "overlay-victory" : "overlay-defeat"}`}>
          <div className="overlay-content">
            <span className="overlay-icon">{isVictory ? "🏆" : "💥"}</span>
            <span className="overlay-text">
              {isVictory ? "Victory!" : "Game Over"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
